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
import { attemptChargeTx, refundChargeTx } from "./store.ts";
import type { ChargeResult, ServiceCharge } from "./types.ts";

export interface AttemptChargeInput {
  suiAddress: string;
  pmId: string | null;
  cost: number;            // credits — must be a non-negative integer
  nonce: string;           // PK for idempotency; rebalancer uses `${tickId}:${pmId}`
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
