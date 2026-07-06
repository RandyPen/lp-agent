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
 *      was lost (equivocation guard). If found, its result is returned as
 *      success.
 *   3. Only clearly-transient transport errors are retried. Anything that
 *      looks like an execution result (Move abort, insufficient gas, invalid
 *      input) is surfaced immediately — retrying those wastes the tick and
 *      hides the real cause.
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

  const bytes = await tx.build({ client });
  const digest = TransactionDataBuilder.getDigestFromBytes(bytes);
  const { signature } = await signer.signTransaction(bytes);

  let lastErr: unknown;
  for (let attempt = 0; attempt <= attempts; attempt++) {
    if (attempt > 0) {
      await sleep(backoffMs);
      // Equivocation guard: the previous submit may have landed even though
      // the response was lost. Never resubmit before checking.
      try {
        const existing = await client.getTransactionBlock({
          digest,
          options: { showEvents: true, showEffects: true },
        });
        log.warn("submitWithRetry: tx found on-chain after transient error — treating as success", {
          digest,
          attempt,
        });
        return existing as SubmitResult;
      } catch {
        // Not found (or lookup failed) — proceed to resubmit the same bytes.
      }
    }

    try {
      const result = await client.executeTransactionBlock({
        transactionBlock: bytes,
        signature,
        options: { showEvents: true, showEffects: true },
      });
      return result as SubmitResult;
    } catch (err) {
      lastErr = err;
      if (!isTransientRpcError(err)) throw err;
      log.warn("submitWithRetry: transient RPC error", {
        digest,
        attempt,
        remaining: attempts - attempt,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`submitWithRetry: exhausted retries: ${String(lastErr)}`);
}
