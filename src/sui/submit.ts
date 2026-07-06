/**
 * Transaction submission with bounded, idempotent retry.
 *
 * Semantics (why this is safe):
 *   1. The transaction is BUILT and SIGNED exactly once. Retries resubmit the
 *      identical signed bytes — Sui dedupes by digest, so a resubmit can never
 *      double-execute. (Rebuilding on retry would pick fresh gas-object
 *      versions → a different digest → potential double-execution. Never
 *      rebuild.)
 *   2. Before any resubmit we first query the digest: a "transient" network
 *      error frequently means the tx actually landed and only the response
 *      was lost (equivocation guard). If found, its result is checked for
 *      on-chain success (see below) and returned.
 *   3. Only clearly-transient transport errors are retried. Anything that
 *      looks like an execution result (Move abort, insufficient gas, invalid
 *      input) is surfaced immediately — retrying those wastes the tick and
 *      hides the real cause.
 *   4. A tx can be COMMITTED but still ABORT (Move abort, slippage guard,
 *      etc.) — that is not a transport error, it is a definitive execution
 *      result. Every result (from executeTransactionBlock OR a digest
 *      lookup) is checked against `effects.status.status` before being
 *      returned; a non-"success" status (or missing effects entirely) throws
 *      `OnChainExecutionError` immediately — never retried, since resubmitting
 *      identical bytes against an already-committed abort cannot change the
 *      outcome.
 *   5. Gas-coin selection during `tx.build()` is NOT coordinated across
 *      concurrent calls — two builds racing for the same signer's OWNED gas
 *      coin OBJECTS can pick the same object, and whichever lands second sees
 *      a stale object version (`ObjectNotFound`/version-conflict). Rather than
 *      serializing submissions (rebalance cadence is minutes, but that still
 *      needlessly queues unrelated PMs behind each other), gas is paid from
 *      the signer's Sui **address balance** instead of an owned coin object:
 *      `tx.setGasPayment([])` is forced before `build()`, which tells the SDK
 *      resolver there is no gas-coin object to select in the first place —
 *      the chain mints an ephemeral gas coin from the address balance for the
 *      transaction's lifetime. No owned object, no contention. This requires
 *      the signer's address balance (NOT its coin-object balance) to be
 *      funded — see `assertSufficientAddressBalance` below and
 *      `scripts/fund-address-balance.ts`. If the balance is insufficient we
 *      fail loud with `InsufficientAddressBalanceError` rather than silently
 *      falling back to owned-coin gas selection (a silent fallback here would
 *      just reintroduce the contention bug intermittently, exactly when the
 *      balance dips — much harder to debug than a clear startup-time error).
 */

import { TransactionDataBuilder } from "@mysten/sui/transactions";
import type { Transaction } from "@mysten/sui/transactions";
import type { Signer } from "@mysten/sui/cryptography";
import type { SuiClient } from "./client.ts";
import { loadConfig } from "../config.ts";
import { log } from "../lib/logger.ts";

/** Response shape shared by executeTransactionBlock / getTransactionBlock. */
export interface SubmitResult {
  digest: string;
  events?: Array<unknown> | null;
  effects?: unknown;
}

/**
 * Thrown when a transaction was committed on-chain but did not succeed (Move
 * abort, slippage guard, etc.), or when the RPC response is missing effects
 * entirely. This is a definitive execution result, never a transport error —
 * callers must not retry it (the same signed bytes would only re-execute the
 * same abort, or worse, be rejected as an equivocation).
 */
export class OnChainExecutionError extends Error {
  readonly digest: string;
  readonly effectsError: string;

  constructor(digest: string, effectsError: string) {
    super(`on-chain execution failed for digest ${digest}: ${effectsError}`);
    this.name = "OnChainExecutionError";
    this.digest = digest;
    this.effectsError = effectsError;
  }
}

/**
 * Assert that an execution/lookup result actually succeeded on-chain. Move
 * aborts, slippage-guard trips, etc. are still committed transactions — the
 * RPC call itself doesn't throw, only `effects.status.status` reveals the
 * outcome. Throws `OnChainExecutionError` (never retried by the caller) when
 * the status is anything but "success", including when effects are absent
 * altogether (fail loud rather than assume success).
 */
function assertExecutionSucceeded(result: SubmitResult, digest: string): SubmitResult {
  const status = (result.effects as { status?: { status?: string; error?: string } } | undefined)
    ?.status;
  if (!status?.status) {
    throw new OnChainExecutionError(digest, "RPC response is missing effects.status");
  }
  if (status.status !== "success") {
    throw new OnChainExecutionError(digest, status.error ?? "unknown on-chain failure");
  }
  return result;
}

const TRANSIENT_PATTERNS: RegExp[] = [
  /fetch failed/i,
  /econnreset/i,
  /econnrefused/i,
  /etimedout/i,
  /socket/i,
  /network/i,
  /timeout/i,
  /\b429\b/,
  /\b502\b/,
  /\b503\b/,
  /\b504\b/,
  /too many requests/i,
  /gateway/i,
];

const NON_RETRYABLE_PATTERNS: RegExp[] = [
  /moveabort/i,
  /move abort/i,
  /insufficientgas/i,
  /insufficient gas/i,
  /invalidinput/i,
  /commandargumenterror/i,
  /objectnotfound/i,
  /notexists/i,
  /abort/i,
];

/**
 * Classify an error as transient (safe to retry with identical bytes).
 * Execution-level failures are NEVER transient, even when their message also
 * matches a transport pattern.
 */
export function isTransientRpcError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (NON_RETRYABLE_PATTERNS.some((re) => re.test(msg))) return false;
  return TRANSIENT_PATTERNS.some((re) => re.test(msg));
}

export interface SubmitWithRetryOpts {
  /** Extra attempts after the first submit (default: cfg RPC_RETRY_ATTEMPTS). */
  attempts?: number;
  /** Delay before each retry / digest check (default: cfg RPC_RETRY_BACKOFF_MS). */
  backoffMs?: number;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Skip the address-balance pre-flight check (tests only). */
  skipBalanceCheck?: boolean;
}

/**
 * Minimum SUI address-balance floor before we'll submit a gas-paying tx.
 * Rebalance PTBs typically cost a small fraction of a SUI in gas; 0.5 SUI
 * gives the operator headroom for many ticks before a top-up is needed.
 */
export const MIN_ADDRESS_BALANCE_MIST = 500_000_000n; // 0.5 SUI

/** How long a passing balance check is trusted before re-querying the RPC. */
const ADDRESS_BALANCE_CHECK_TTL_MS = 60_000;

const lastBalanceCheckOkAt = new Map<string, number>();

/**
 * Thrown when the signer's Sui address balance (NOT its owned coin-object
 * balance — see module doc point 5) is below `MIN_ADDRESS_BALANCE_MIST`, or
 * when the RPC response doesn't expose an address-balance field at all (e.g.
 * an older node that predates the feature). Never silently falls back to
 * owned-coin gas selection — that would reintroduce the exact contention bug
 * this design avoids, just intermittently.
 */
export class InsufficientAddressBalanceError extends Error {
  readonly address: string;
  readonly addressBalanceMist: bigint | null;

  constructor(address: string, addressBalanceMist: bigint | null) {
    const have =
      addressBalanceMist === null ? "unknown (RPC response had no addressBalance field)" : `${addressBalanceMist} MIST`;
    super(
      `agent address ${address} has insufficient Sui address-balance for gas ` +
        `(have ${have}, need >= ${MIN_ADDRESS_BALANCE_MIST} MIST). ` +
        `Fund it with: bun run scripts/fund-address-balance.ts <amount-sui>`,
    );
    this.name = "InsufficientAddressBalanceError";
    this.address = address;
    this.addressBalanceMist = addressBalanceMist;
  }
}

/**
 * Lazy, cached (`ADDRESS_BALANCE_CHECK_TTL_MS`) pre-flight check that the
 * signer's address balance can cover gas. Fails loud — never coerces a
 * missing/insufficient balance into "proceed anyway" (see class doc above).
 */
async function assertSufficientAddressBalance(client: SuiClient, address: string): Promise<void> {
  const lastOk = lastBalanceCheckOkAt.get(address);
  const now = Date.now();
  if (lastOk !== undefined && now - lastOk < ADDRESS_BALANCE_CHECK_TTL_MS) return;

  const { balance } = await client.core.getBalance({ owner: address });
  if (balance.addressBalance === undefined || balance.addressBalance === null) {
    throw new InsufficientAddressBalanceError(address, null);
  }
  const addressBalanceMist = BigInt(balance.addressBalance);
  if (addressBalanceMist < MIN_ADDRESS_BALANCE_MIST) {
    throw new InsufficientAddressBalanceError(address, addressBalanceMist);
  }
  lastBalanceCheckOkAt.set(address, now);
}

export function resetAddressBalanceCheckCacheForTests(): void {
  lastBalanceCheckOkAt.clear();
}

/**
 * Build once, sign once, submit; on a transient error check whether the tx
 * landed (by digest) and otherwise resubmit the identical signed bytes up to
 * `attempts` more times.
 */
export async function submitWithRetry(
  client: SuiClient,
  tx: Transaction,
  signer: Signer,
  opts: SubmitWithRetryOpts = {},
): Promise<SubmitResult> {
  const cfg = loadConfig();
  const attempts = opts.attempts ?? cfg.rpcRetryAttempts;
  const backoffMs = opts.backoffMs ?? cfg.rpcRetryBackoffMs;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const address = signer.toSuiAddress();
  if (!opts.skipBalanceCheck) {
    await assertSufficientAddressBalance(client, address);
  }

  // Force balance-paid gas: no owned gas-coin object is selected, so
  // concurrent submissions for this signer never race over the same object
  // (see module doc point 5). If the address balance turns out to be
  // insufficient at resolve/execution time, the SDK/chain rejects the tx
  // loudly rather than us silently reselecting owned coins.
  tx.setGasPayment([]);

  const bytes = await tx.build({ client });
  const digest = TransactionDataBuilder.getDigestFromBytes(bytes);
  const { signature } = await signer.signTransaction(bytes);

  /** Equivocation guard: look up the digest; undefined means "not found". */
  async function lookupExisting(): Promise<SubmitResult | undefined> {
    try {
      return (await client.getTransactionBlock({
        digest,
        options: { showEvents: true, showEffects: true },
      })) as SubmitResult;
    } catch {
      return undefined;
    }
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt <= attempts; attempt++) {
    if (attempt > 0) {
      await sleep(backoffMs);
      // The previous submit may have landed even though the response was
      // lost. Never resubmit before checking. `assertExecutionSucceeded`
      // runs OUTSIDE this try/catch on purpose — an abort discovered here
      // must propagate as a definitive failure, not be swallowed as
      // "not found" and trigger a pointless resubmit.
      const existing = await lookupExisting();
      if (existing) {
        log.warn("submitWithRetry: tx found on-chain after transient error — treating as success", {
          digest,
          attempt,
        });
        return assertExecutionSucceeded(existing, digest);
      }
    }

    let result: SubmitResult | undefined;
    try {
      result = (await client.executeTransactionBlock({
        transactionBlock: bytes,
        signature,
        options: { showEvents: true, showEffects: true },
      })) as SubmitResult;
    } catch (err) {
      lastErr = err;
      if (!isTransientRpcError(err)) throw err;
      log.warn("submitWithRetry: transient RPC error", {
        digest,
        attempt,
        remaining: attempts - attempt,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    // Outside the try/catch above: an on-chain abort must propagate as-is,
    // never be reclassified via isTransientRpcError and retried.
    return assertExecutionSucceeded(result, digest);
  }

  // Exhausted all attempts. The final executeTransactionBlock call may still
  // have landed with only its response lost — check once more before giving
  // up (same success/abort gating as every other lookup above).
  await sleep(backoffMs);
  const finalExisting = await lookupExisting();
  if (finalExisting) {
    log.warn("submitWithRetry: tx found on-chain on final check after exhausting retries — treating as success", {
      digest,
    });
    return assertExecutionSucceeded(finalExisting, digest);
  }

  throw lastErr instanceof Error
    ? lastErr
    : new Error(`submitWithRetry: exhausted retries: ${String(lastErr)}`);
}
