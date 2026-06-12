/**
 * Treasury balance watcher.
 *
 * Polls every registered user's deposit address every N seconds, compares
 * each (coin_type, balance) against the cached snapshot, and inserts a
 * `treasury_deposits` row + bumps `treasury_users.credits` whenever a
 * positive delta is observed. All writes go through the atomic
 * `recordDepositTx` so a crash mid-watcher never partially credits.
 *
 * Idempotency contract:
 *   - The cache (`treasury_address_balances.last_seen_balance`) is the source
 *     of truth for "what we've already credited". A restart re-reads the
 *     cache; only NEW positive deltas trigger inserts.
 *   - On startup the watcher does NOT do a one-shot reconciliation pass —
 *     existing on-chain balances vs. cached gaps would be treated as new
 *     deposits. If you sweep externally, update the cache manually first
 *     (or use `getAllBalances` once to seed the cache before sweeping).
 *
 * Delta semantics:
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
import { log } from "../lib/logger.ts";
import { canonicalType } from "../sui/lending/typeNorm.ts";
import {
  getAddressBalance,
  getCreditRate,
  listUsers,
  recordDepositTx,
  upsertAddressBalance,
} from "./store.ts";
import { creditsForAmount } from "./credits.ts";
import type { TreasuryUser } from "./types.ts";

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
    const snap = getAddressBalance(user.depositAddress, coinType);
    const prevBalance = snap?.lastSeenBalance ?? 0n;
    const delta = currentBalance - prevBalance;

    if (delta === 0n) continue;

    if (delta < 0n) {
      // External sweep / operator move: only update cache, never reduce credits.
      upsertAddressBalance({
        depositAddress: user.depositAddress,
        coinType,
        lastSeenBalance: currentBalance,
        lastSeenMs: nowMs,
      });
      log.info("treasury/watcher: outflow observed (cache updated, credits unchanged)", {
        depositAddress: user.depositAddress,
        coinType,
        delta: delta.toString(),
        newBalance: currentBalance.toString(),
      });
      continue;
    }

    // delta > 0 — record a deposit row + bump credits.
    const rate = getCreditRate(coinType);
    const grantedCredits = creditsForAmount(delta, rate);

    recordDepositTx({
      id: newDepositId(),
      suiAddress: user.suiAddress,
      depositAddress: user.depositAddress,
      coinType,
      amountDelta: delta,
      prevBalance,
      newBalance: currentBalance,
      creditsGranted: grantedCredits,
      rateNum: rate?.rateNum ?? null,
      rateDen: rate?.rateDen ?? null,
      observedAtMs: nowMs,
    });
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
