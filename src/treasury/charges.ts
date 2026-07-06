/**
 * Public surface for service-fee charging from the rebalancer.
 *
 * Wraps the atomic store operations `attemptChargeTx` / `refundChargeTx` and
 * adds logging. The rebalancer calls `attemptCharge` BEFORE executing an
 * on-chain plan; on plan failure it calls `refundCharge` with the same
 * `nonce` to restore the user's credits.
 *
 * v1 invariant: NO user signature required for internal rebalancer-driven
 * charges. The PM owner authorises this implicitly by delegating trustee
 * permission to the agent address via the on-chain `AgentAdded` event.
 * v2 will add HTTP API + signature-verified charges; see treasury-role-design
 * §"v2 backlog".
 */

import { log } from "../lib/logger.ts";
import { verifyPersonalMessageSignature } from "@mysten/sui/verify";
import { getDb } from "../db/client.ts";
import { attemptChargeTx, refundChargeTx, findUserBySuiAddress } from "./store.ts";
import type { ChargeResult, ServiceCharge } from "./types.ts";

export interface AttemptChargeInput {
  suiAddress: string;
  pmId: string | null;
  cost: number;            // credits — must be a non-negative integer
  nonce: string;           // PK for idempotency; rebalancer uses `${tickId}:${pmId}`
  memo?: string | null;
}

export interface ChargeWithSignatureInput {
  suiAddress: string;
  credits: number;          // must be a positive integer
  messageB64: string;       // base64-encoded signed message
  signature: string;        // sui personal-message signature
  nonce: string;            // replay-protection nonce
  memo?: string | null;
}

/**
 * Attempt to debit `cost` credits from `suiAddress`. Atomic across nonce
 * check + balance check + decrement. Idempotent on `nonce` (repeated calls
 * with the same nonce return the existing row).
 */
export function attemptCharge(input: AttemptChargeInput): ChargeResult {
  const row = attemptChargeTx({
    nonce: input.nonce,
    suiAddress: input.suiAddress,
    pmId: input.pmId,
    cost: input.cost,
    memo: input.memo ?? null,
  });
  return chargeRowToResult(row, input.cost);
}

/**
 * Refund a previously `ok` charge. Idempotent — already-refunded or
 * non-existent nonces silently noop and return false.
 */
export function refundCharge(nonce: string, reason: string): boolean {
  const refunded = refundChargeTx(nonce, reason);
  if (refunded) {
    log.info("treasury/charges: refunded", { nonce, reason });
  }
  return refunded;
}

/**
 * HTTP API variant of `attemptCharge` that requires a Sui personal-message
 * signature. Implements nonce-first audit: the nonce row is written BEFORE
 * signature verification so every attempt (including bad-sig) is recorded.
 *
 * Signed message format: `LiquidityManager:charge:<suiAddress>:<credits>:<nonce>`
 */
export async function chargeForServiceWithSignature(
  input: ChargeWithSignatureInput,
): Promise<ChargeResult & { remainingCredits: number }> {
  const { suiAddress, credits, messageB64, signature, nonce, memo } = input;

  log.info("treasury/charges: chargeForServiceWithSignature", {
    suiAddress,
    credits,
    nonce,
    sigPrefix: signature.slice(0, 8),
  });

  if (!Number.isInteger(credits) || credits <= 0) {
    throw new Error(`chargeForServiceWithSignature: credits must be a positive integer, got ${credits}`);
  }
  if (!nonce || nonce.trim() === "") {
    throw new Error("chargeForServiceWithSignature: nonce must be a non-empty string");
  }

  // Decode and validate message format.
  const message = Buffer.from(messageB64, "base64").toString("utf-8");
  const expectedMessage = `LiquidityManager:charge:${suiAddress}:${credits}:${nonce}`;
  if (message !== expectedMessage) {
    throw new Error(
      `chargeForServiceWithSignature: message mismatch. expected='${expectedMessage}' got='${message}'`,
    );
  }

  const db = getDb();
  const nowMs = Date.now();

  // Nonce-first audit: insert BEFORE signature verification.
  // If UNIQUE constraint fires, inspect existing status for idempotency.
  try {
    db.prepare(
      `INSERT INTO treasury_charge_nonces
         (sui_address, nonce, status, error, created_at_ms)
       VALUES (?, ?, 'pending', NULL, ?)`,
    ).run(suiAddress, nonce, nowMs);
  } catch (err: unknown) {
    // UNIQUE constraint violation — nonce already exists for this address.
    const existing = db
      .query<{ status: string; error: string | null }, [string, string]>(
        "SELECT status, error FROM treasury_charge_nonces WHERE sui_address = ? AND nonce = ?",
      )
      .get(suiAddress, nonce);

    if (existing?.status === "accepted") {
      // Idempotent: previous attempt succeeded — return existing charge result.
      const chargeRow = db
        .query<{ credits_debited: number }, [string]>(
          "SELECT credits_debited FROM treasury_service_charges WHERE nonce = ?",
        )
        .get(nonce);
      const user = findUserBySuiAddress(suiAddress);
      return {
        ok: true,
        chargeNonce: nonce,
        remainingCredits: user?.credits ?? 0,
        error: undefined,
      };
    }
    if (existing?.status === "pending") {
      throw new Error(`chargeForServiceWithSignature: nonce '${nonce}' is in pending state — concurrent request?`);
    }
    // status === 'rejected' (previous bad-sig attempt)
    throw new Error(`chargeForServiceWithSignature: nonce '${nonce}' was previously rejected with error='${existing?.error ?? "unknown"}'`);
  }

  // Verify signature. Returns the public key whose private key signed the message.
  let recoveredAddress: string;
  try {
    const msgBytes = new TextEncoder().encode(message);
    const publicKey = await verifyPersonalMessageSignature(msgBytes, signature);
    recoveredAddress = publicKey.toSuiAddress();
  } catch (_verifyErr: unknown) {
    // Verification threw — treat as bad_signature.
    db.prepare(
      `UPDATE treasury_charge_nonces
       SET status = 'rejected', error = 'bad_signature'
       WHERE sui_address = ? AND nonce = ?`,
    ).run(suiAddress, nonce);
    throw new Error("bad_signature");
  }

  if (recoveredAddress !== suiAddress) {
    db.prepare(
      `UPDATE treasury_charge_nonces
       SET status = 'rejected', error = 'bad_signature'
       WHERE sui_address = ? AND nonce = ?`,
    ).run(suiAddress, nonce);
    throw new Error("bad_signature");
  }

  // Signature valid — attempt the charge. The debit (attemptChargeTx, which
  // is itself a `db.transaction`) and the nonce status transition to
  // 'accepted' are wrapped in ONE outer transaction here — bun:sqlite nests
  // this as a SAVEPOINT, so the debit and the nonce-status flip commit or
  // roll back together. Previously these were separate statements: a crash
  // between them left the nonce permanently 'pending' (see the throw above
  // for that state) while the user had already been charged.
  const row = db.transaction(() => {
    const chargeRow = attemptChargeTx({
      nonce,
      suiAddress,
      pmId: null,
      cost: credits,
      memo: memo ?? null,
    });

    if (chargeRow.status === "ok") {
      const verifiedAtMs = Date.now();
      // Record signature metadata on the charge row.
      db.prepare(
        `UPDATE treasury_service_charges
         SET signature = ?, message_b64 = ?, verified_at_ms = ?
         WHERE nonce = ?`,
      ).run(signature, messageB64, verifiedAtMs, nonce);
    }

    // Whether the charge succeeded or was rejected (not_registered /
    // insufficient_credits), the nonce was consumed — mark it accepted in
    // the SAME transaction as the debit attempt.
    db.prepare(
      `UPDATE treasury_charge_nonces
       SET status = 'accepted'
       WHERE sui_address = ? AND nonce = ?`,
    ).run(suiAddress, nonce);

    return chargeRow;
  })();

  const user = findUserBySuiAddress(suiAddress);
  if (row.status === "ok") {
    return {
      ok: true,
      chargeNonce: nonce,
      remainingCredits: user?.credits ?? 0,
      error: undefined,
    };
  }

  return {
    ok: false,
    chargeNonce: nonce,
    remainingCredits: user?.credits ?? 0,
    error: row.error ?? undefined,
  };
}

// ----------------------------------------------------------------------

function chargeRowToResult(row: ServiceCharge, requestedCost: number): ChargeResult {
  const ok = row.status === "ok";
  if (!ok) {
    log.warn("treasury/charges: rejected", {
      nonce: row.nonce,
      suiAddress: row.suiAddress,
      requestedCost,
      error: row.error,
    });
  } else if (row.creditsDebited === requestedCost) {
    log.info("treasury/charges: ok", {
      nonce: row.nonce,
      suiAddress: row.suiAddress,
      debited: row.creditsDebited,
    });
  } else {
    // Idempotent replay: existing row with different cost (rare; would
    // indicate the rebalancer re-issued with a different number under the
    // same nonce). Surface to logs.
    log.warn("treasury/charges: nonce replay returned existing row with different debited amount", {
      nonce: row.nonce,
      requestedCost,
      previouslyDebited: row.creditsDebited,
    });
  }
  return {
    ok,
    chargeNonce: row.nonce,
    remainingCredits: -1, // store doesn't return user.credits — caller can re-read if needed
    error: row.error ?? undefined,
  };
}
