/**
 * Treasury balance watcher.
 *
 * Polls every registered user's deposit address every N seconds, compares
 * each (coin_type, balance) against the last CONFIRMED snapshot, and inserts
 * a `treasury_deposits` row + bumps `treasury_users.credits` whenever a
 * CONFIRMED positive delta is observed. All crediting writes go through the
 * atomic `recordDepositTx` so a crash mid-watcher never partially credits.
 *
 * Confirmation debounce (dip-then-recover double-credit fix):
 *   Acting on a single balance observation is unsafe — an RPC lag / an
 *   inconsistent replica can transiently report a balance that later
 *   reverts (e.g. 100 -> 40 -> 100). Sui has fast deterministic finality, so
 *   the threat here is RPC/replica inconsistency, not a deep chain reorg.
 *   We therefore require the SAME new balance to be observed on
 *   `BALANCE_CONFIRM_POLLS` consecutive polls — in EITHER direction —
 *   before acting on it:
 *     - Balance back at the confirmed baseline: any in-flight pending
 *       observation is cleared (the change reverted before confirmation);
 *       no credit change.
 *     - Balance differs from baseline but hasn't been confirmed yet: the
 *       observation is persisted (`pending_balance`/`pending_count` on
 *       `treasury_address_balances`) and no action is taken. Persisting
 *       additively means a restart mid-confirmation resumes the count
 *       instead of re-arming from zero.
 *     - Balance confirmed (same value seen `BALANCE_CONFIRM_POLLS` times):
 *       act on the delta against the last CONFIRMED baseline — credit on
 *       delta > 0, just move the baseline on delta < 0 — then clear pending.
 *
 * Idempotency contract:
 *   - The cache (`treasury_address_balances.last_seen_balance`) is the source
 *     of truth for "what we've already credited" — it only ever advances to
 *     a CONFIRMED balance. A restart re-reads the cache (baseline + any
 *     pending observation); only NEW confirmed positive deltas trigger
 *     inserts.
 *   - On startup the watcher does NOT do a one-shot reconciliation pass —
 *     existing on-chain balances vs. cached gaps would be treated as new
 *     deposits. If you sweep externally, update the cache manually first
 *     (or use `getAllBalances` once to seed the cache before sweeping).
 *
 * Delta semantics (post-confirmation):
 *   - `delta > 0`: new deposit — record + credit (credits=0 if no rate set;
 *     the row exists for audit + later backfill).
 *   - `delta < 0`: external sweep / operator move — only update cache,
 *     credits remain.
 *   - `delta = 0`: no-op.
 *
 * Failure isolation: per-address fetch errors are logged and skipped; one
 * broken RPC for one user does not block other users in the same tick.
 */

import type { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { getDb } from "../db/client.ts";
import { log } from "../lib/logger.ts";
import { canonicalType } from "../sui/lending/typeNorm.ts";
import {
  getCreditRate,
  listUsers,
  recordDepositTx,
  upsertAddressBalance,
} from "./store.ts";
import { creditsForAmount } from "./credits.ts";
import type { TreasuryUser } from "./types.ts";

/**
 * Number of consecutive polls that must observe the SAME new balance before
 * the watcher acts on it (either direction). 2 is the minimum that turns a
 * single-sample glitch into "seen twice in a row" without adding much
 * latency to genuine deposits (one extra poll interval).
 */
const BALANCE_CONFIRM_POLLS = 2;

interface BalanceCacheState {
  /** Last CONFIRMED balance — the baseline credits have been booked against. */
  confirmed: bigint;
  /** Not-yet-confirmed observed balance, or null when nothing is pending. */
  pendingBalance: bigint | null;
  pendingCount: number;
}

interface BalanceCacheRow {
  last_seen_balance: string;
  pending_balance: string | null;
  pending_count: number;
}

/**
 * Raw read of the confirmation-tracking columns on `treasury_address_balances`.
 * Deliberately bypasses `store.ts`'s `getAddressBalance` (which only exposes
 * the confirmed baseline) — the debounce logic needs the pending columns too.
 */
function readBalanceCache(depositAddress: string, coinType: string): BalanceCacheState | null {
  const db = getDb();
  const row = db
    .query<BalanceCacheRow, [string, string]>(
      `SELECT last_seen_balance, pending_balance, pending_count
       FROM treasury_address_balances
       WHERE deposit_address = ? AND coin_type = ?`,
    )
    .get(depositAddress, coinType);
  if (!row) return null;
  return {
    confirmed: BigInt(row.last_seen_balance),
    pendingBalance: row.pending_balance !== null ? BigInt(row.pending_balance) : null,
    pendingCount: row.pending_count,
  };
}

/**
 * Persist a not-yet-confirmed observation. `baselineBalance` is only used
 * when no row exists yet (brand-new address) — it seeds `last_seen_balance`
 * on insert; on conflict the existing confirmed baseline is left untouched.
 */
function writePendingObservation(args: {
  depositAddress: string;
  coinType: string;
  baselineBalance: bigint;
  pendingBalance: bigint;
  pendingCount: number;
  nowMs: number;
}): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO treasury_address_balances
       (deposit_address, coin_type, last_seen_balance, last_seen_ms, pending_balance, pending_count)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(deposit_address, coin_type) DO UPDATE SET
       pending_balance = excluded.pending_balance,
       pending_count   = excluded.pending_count,
       last_seen_ms    = excluded.last_seen_ms`,
  ).run(
    args.depositAddress,
    args.coinType,
    args.baselineBalance.toString(),
    args.nowMs,
    args.pendingBalance.toString(),
    args.pendingCount,
  );
}

/** Clear any in-flight pending observation without touching the confirmed baseline. */
function clearPendingObservation(depositAddress: string, coinType: string): void {
  const db = getDb();
  db.prepare(
    `UPDATE treasury_address_balances
     SET pending_balance = NULL, pending_count = 0
     WHERE deposit_address = ? AND coin_type = ?`,
  ).run(depositAddress, coinType);
}

export interface WatcherTickStats {
  usersScanned: number;
  newDeposits: number;
  creditsGrantedTotal: number;
  errors: number;
}

export interface WatcherClient {
  /**
   * Compatible subset of `SuiClient.getAllBalances({owner})`. Tests pass
   * a stub; production uses the real Sui client.
   *
   * Gasless deposit visibility: the @mysten/sui JSON-RPC `getAllBalances`
   * response includes a `fundsInAddressBalance` field per coin type (see
   * `node_modules/@mysten/sui/dist/jsonRpc/types/coins.d.mts`, `CoinBalance`).
   * When a user pays via `0x2::balance::send_funds` (the gasless path), their
   * stablecoin lands in the deposit address's *address balance accumulator*,
   * not as a Coin object.  The SDK's `totalBalance` field reflects coin-object
   * holdings only; `fundsInAddressBalance` is the address-balance amount.
   *
   * We surface the combined total (coin objects + address balance) as
   * `totalBalance` in this interface so the watcher credits both sources.
   * The `suiClientAsWatcherClient` adapter merges them; test stubs may omit
   * `fundsInAddressBalance` (it defaults to "0").
   */
  getAllBalances(args: { owner: string }): Promise<
    Array<{ coinType: string; totalBalance: string }>
  >;
}

export interface WatcherService {
  /** Run one polling cycle now. Returns stats. */
  pollOnce(): Promise<WatcherTickStats>;
  /** Start periodic polling. Returns stop handle. */
  start(): () => void;
}

interface CreateWatcherOpts {
  client: WatcherClient;
  intervalMs: number;
}

/**
 * Generate a sortable, unique-ish ID for a `treasury_deposits` row.
 *
 * Format: `dep_<base36 timestamp>_<base36 random>` — not a full ULID spec but
 * monotonic-by-time within a single process and unique-enough for our
 * volume. Avoids adding `ulid` as a dep.
 */
function newDepositId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 0xffffffff).toString(36);
  return `dep_${ts}_${rand}`;
}

async function tickOneUser(
  client: WatcherClient,
  user: TreasuryUser,
  nowMs: number,
): Promise<{ newDeposits: number; creditsGranted: number }> {
  let newDeposits = 0;
  let creditsGranted = 0;

  let balances: Awaited<ReturnType<WatcherClient["getAllBalances"]>>;
  try {
    balances = await client.getAllBalances({ owner: user.depositAddress });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("treasury/watcher: getAllBalances failed", {
      depositAddress: user.depositAddress,
      error: msg,
    });
    throw err; // surface to caller for error count
  }

  for (const b of balances) {
    const coinType = canonicalType(b.coinType);
    const currentBalance = BigInt(b.totalBalance);
    const cache = readBalanceCache(user.depositAddress, coinType);
    const confirmedBalance = cache?.confirmed ?? 0n;

    if (currentBalance === confirmedBalance) {
      // Back at (or still at) the confirmed baseline. Clear any in-flight
      // pending observation — e.g. a transient dip that has since recovered,
      // or a still-unconfirmed change that reverted before confirmation.
      if (cache && (cache.pendingBalance !== null || cache.pendingCount !== 0)) {
        clearPendingObservation(user.depositAddress, coinType);
        log.debug("treasury/watcher: pending balance change reverted before confirmation", {
          depositAddress: user.depositAddress,
          coinType,
          confirmedBalance: confirmedBalance.toString(),
        });
      }
      continue;
    }

    // Balance differs from the confirmed baseline — debounce before acting.
    const pendingMatches = cache?.pendingBalance === currentBalance;
    const pendingCount = pendingMatches ? (cache?.pendingCount ?? 0) + 1 : 1;

    if (pendingCount < BALANCE_CONFIRM_POLLS) {
      writePendingObservation({
        depositAddress: user.depositAddress,
        coinType,
        baselineBalance: confirmedBalance,
        pendingBalance: currentBalance,
        pendingCount,
        nowMs,
      });
      log.debug("treasury/watcher: balance change observed, awaiting confirmation", {
        depositAddress: user.depositAddress,
        coinType,
        confirmedBalance: confirmedBalance.toString(),
        observedBalance: currentBalance.toString(),
        pendingCount,
        requiredPolls: BALANCE_CONFIRM_POLLS,
      });
      continue;
    }

    // Confirmed: the SAME new balance has now been observed
    // BALANCE_CONFIRM_POLLS times in a row. Act against the last CONFIRMED
    // baseline — there is only ever one pending value in flight per
    // (address, coin), so this is the exact delta to apply.
    const delta = currentBalance - confirmedBalance;

    if (delta < 0n) {
      // External sweep / operator move: only update cache, never reduce credits.
      upsertAddressBalance({
        depositAddress: user.depositAddress,
        coinType,
        lastSeenBalance: currentBalance,
        lastSeenMs: nowMs,
      });
      clearPendingObservation(user.depositAddress, coinType);
      log.info("treasury/watcher: outflow confirmed (cache updated, credits unchanged)", {
        depositAddress: user.depositAddress,
        coinType,
        delta: delta.toString(),
        newBalance: currentBalance.toString(),
      });
      continue;
    }

    // delta > 0 — confirmed deposit: record a deposit row + bump credits.
    const rate = getCreditRate(coinType);
    const grantedCredits = creditsForAmount(delta, rate);

    recordDepositTx({
      id: newDepositId(),
      suiAddress: user.suiAddress,
      depositAddress: user.depositAddress,
      coinType,
      amountDelta: delta,
      prevBalance: confirmedBalance,
      newBalance: currentBalance,
      creditsGranted: grantedCredits,
      rateNum: rate?.rateNum ?? null,
      rateDen: rate?.rateDen ?? null,
      observedAtMs: nowMs,
    });
    clearPendingObservation(user.depositAddress, coinType);
    newDeposits++;
    creditsGranted += grantedCredits;

    if (rate === null) {
      log.warn("treasury/watcher: deposit recorded with credits=0 — coin has no rate", {
        suiAddress: user.suiAddress,
        coinType,
        delta: delta.toString(),
      });
    } else {
      log.info("treasury/watcher: deposit credited", {
        suiAddress: user.suiAddress,
        coinType,
        delta: delta.toString(),
        creditsGranted: grantedCredits,
      });
    }
  }

  return { newDeposits, creditsGranted };
}

export function createTreasuryWatcher(opts: CreateWatcherOpts): WatcherService {
  let inFlight = false;

  async function pollOnce(): Promise<WatcherTickStats> {
    const stats: WatcherTickStats = {
      usersScanned: 0,
      newDeposits: 0,
      creditsGrantedTotal: 0,
      errors: 0,
    };
    const users = listUsers();
    if (users.length === 0) {
      log.debug("treasury/watcher: no registered users, skipping tick");
      return stats;
    }
    const nowMs = Date.now();
    for (const user of users) {
      stats.usersScanned++;
      try {
        const res = await tickOneUser(opts.client, user, nowMs);
        stats.newDeposits += res.newDeposits;
        stats.creditsGrantedTotal += res.creditsGranted;
      } catch {
        stats.errors++;
        // already logged in tickOneUser
      }
    }
    log.debug("treasury/watcher: tick complete", {
      usersScanned: stats.usersScanned,
      newDeposits: stats.newDeposits,
      creditsGrantedTotal: stats.creditsGrantedTotal,
      errors: stats.errors,
    });
    return stats;
  }

  return {
    pollOnce,
    start(): () => void {
      const handle = setInterval(() => {
        if (inFlight) {
          log.debug("treasury/watcher: previous tick still running, skipping");
          return;
        }
        inFlight = true;
        pollOnce()
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            log.error("treasury/watcher: pollOnce threw", { error: msg });
          })
          .finally(() => {
            inFlight = false;
          });
      }, opts.intervalMs);
      return () => clearInterval(handle);
    },
  };
}

/**
 * Helper for production: adapt `@mysten/sui` SuiJsonRpcClient → WatcherClient.
 *
 * Gasless deposit handling: the Sui JSON-RPC `CoinBalance` type includes
 * `fundsInAddressBalance` (optional string), which reports the amount held in
 * the address-balance accumulator — the destination of gasless
 * `0x2::balance::send_funds` transfers. `totalBalance` only counts Coin
 * objects. We add both together so the watcher sees gasless deposits as
 * positive deltas and credits them correctly.
 *
 * If `fundsInAddressBalance` is absent or "0", the addition is a no-op.
 */
export function suiClientAsWatcherClient(client: SuiJsonRpcClient): WatcherClient {
  return {
    async getAllBalances({ owner }) {
      const raw = await client.getAllBalances({ owner });
      return raw.map((b: { coinType: string; totalBalance: string; fundsInAddressBalance?: string }) => {
        const coinBalance = BigInt(b.totalBalance);
        const addrBalance = b.fundsInAddressBalance ? BigInt(b.fundsInAddressBalance) : 0n;
        return {
          coinType: b.coinType,
          totalBalance: (coinBalance + addrBalance).toString(),
        };
      });
    },
  };
}
