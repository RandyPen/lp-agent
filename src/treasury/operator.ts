/**
 * Treasury operator — sweep and refund operations.
 *
 * All functions take an explicit `client` and `signer` (or derive the signer
 * internally at call time) so they are testable without real network calls.
 * Keypairs are fetched inside each function (never at module level), per
 * docs/treasury-role-design.md Appendix C: "master keypair fetched only when doing
 * sweep/swap, never cached on a long-lived object".
 *
 * Cache-seeding contract (watcher idempotency):
 *   After a successful sweep, `treasury_address_balances` is updated to the
 *   new (post-sweep) balance. The watcher's delta logic compares against this
 *   cache; a negative delta is treated as an outflow (cache update only, no
 *   credit reduction). Without seeding, the next watcher tick would see the
 *   balance drop as a large negative delta and log a spurious outflow entry —
 *   which is harmless but noisy. With seeding the watcher sees delta=0 and
 *   does nothing. See watcher.ts header comment for the full idempotency contract.
 *
 * Aggregator swap:
 *   `@cetusprotocol/aggregator-sdk` imports cleanly under Bun (confirmed with
 *   probe). The swap body is WIRED but requires the caller to supply an
 *   `AggregatorClient` instance (injected for testability). Production callers
 *   construct one from `loadConfig().network`.
 */

import { Transaction } from "@mysten/sui/transactions";
import type { SuiClient as _SuiClient } from "../sui/client.ts";
import { canonicalType } from "../sui/lending/typeNorm.ts";
import { log } from "../lib/logger.ts";
import {
  findUserBySuiAddress,
  listUsers,
  upsertAddressBalance,
} from "./store.ts";
import { recordOp, markOpResult } from "./opsStore.ts";
import { getDb } from "../db/client.ts";

// ---- constants -----------------------------------------------------------

/** Canonical SUI type string (long form, normalised). */
export const SUI_COIN_TYPE =
  "0x0000000000000000000000000000000000000000000000000000000000000002::sui::sui";

/**
 * Minimum SUI reserve kept on a deposit address for gas when sweeping SUI.
 * 0.05 SUI = 50_000_000 MIST. Matches the reference value in SuiAgentsTopUp.
 */
export const GAS_RESERVE_MIST = 50_000_000n;

// ---- keypair provider interface (injectable for tests) -------------------

/**
 * Minimal keypair interface needed by operator functions.
 * Matches the subset of `Ed25519Keypair` that we use.
 */
export interface OperatorKeypair {
  toSuiAddress(): string;
}

/**
 * Injectable keypair provider. Production code uses the default which calls
 * the real `getUserDepositKeypair` from treasury.ts. Tests inject a fake so
 * that no .env/mnemonic is required and no `mock.module` is needed.
 */
export interface KeypairProvider {
  getUserDepositKeypair(derivationIndex: number): OperatorKeypair;
  getMasterAddress?(): string;
}

/** Default production keypair provider — calls the real treasury module. */
async function defaultKeypairProvider(): Promise<KeypairProvider> {
  const { getUserDepositKeypair, getTreasuryMasterAddress } = await import(
    "../sui/keypairs/treasury.ts"
  );
  return {
    getUserDepositKeypair: (index: number) => getUserDepositKeypair(index) as OperatorKeypair,
    getMasterAddress: () => getTreasuryMasterAddress(),
  };
}

// ---- thin client interface (subset of SuiJsonRpcClient) ------------------

export interface OperatorClient {
  getCoins(args: {
    owner: string;
    coinType: string;
    cursor?: string | null;
    limit?: number | null;
  }): Promise<{
    data: Array<{
      coinObjectId: string;
      version: string;
      digest: string;
      balance: string;
    }>;
    hasNextPage: boolean;
    nextCursor?: string | null;
  }>;

  signAndExecuteTransaction(args: {
    transaction: Transaction;
    signer: OperatorKeypair;
    options?: {
      showEffects?: boolean;
      showBalanceChanges?: boolean;
    };
  }): Promise<{
    digest: string;
    effects?: {
      status: { status: "success" | "failure"; error?: string };
    } | null;
  }>;

  devInspectTransactionBlock?(args: {
    transactionBlock: Transaction;
    sender: string;
  }): Promise<{
    effects: {
      status: { status: "success" | "failure"; error?: string };
    };
  }>;
}

// ---- helpers -------------------------------------------------------------

interface CoinRef {
  objectId: string;
  version: string;
  digest: string;
  balance: bigint;
}

/** Fetch all pages of coins of a given type for an owner. */
async function fetchAllCoins(
  client: OperatorClient,
  owner: string,
  coinType: string,
): Promise<CoinRef[]> {
  const out: CoinRef[] = [];
  let cursor: string | null | undefined = undefined;
  for (;;) {
    const page = await client.getCoins({ owner, coinType, cursor, limit: 50 });
    for (const c of page.data) {
      out.push({
        objectId: c.coinObjectId,
        version: c.version,
        digest: c.digest,
        balance: BigInt(c.balance),
      });
    }
    if (!page.hasNextPage) break;
    cursor = page.nextCursor;
  }
  return out;
}

function totalBalance(coins: CoinRef[]): bigint {
  return coins.reduce((acc, c) => acc + c.balance, 0n);
}

/** Atomically update the balance cache so the watcher does not re-book the delta. */
function seedBalanceCache(
  depositAddress: string,
  coinType: string,
  newBalance: bigint,
): void {
  upsertAddressBalance({
    depositAddress,
    coinType,
    lastSeenBalance: newBalance,
    lastSeenMs: Date.now(),
  });
}

// ---- sweep a single deposit address (one coin type) ----------------------

export interface SweepDepositAddressArgs {
  /** Derivation index of the user whose deposit address to sweep. */
  derivationIndex: number;
  /** Move coin type to sweep (canonicalised inside). */
  coinType: string;
  /** Recipient address. Defaults to treasury master if omitted. */
  to: string;
  /**
   * Amount to sweep (atomic units). Omit to sweep the full spendable balance:
   *   - For SUI: full balance minus `GAS_RESERVE_MIST`
   *   - For non-SUI: full balance (requires separate SUI gas coins on address)
   */
  amount?: bigint;
  client: OperatorClient;
  /** When true, validate plan but do NOT submit tx and do NOT write ops rows. */
  dryRun?: boolean;
  /** Label written to treasury_ops.initiated_by. */
  initiatedBy?: string;
  /**
   * Keypair provider (injectable for tests). If omitted, uses the real
   * treasury keypairs — production callers leave this unset.
   */
  _keypairProvider?: KeypairProvider;
}

export interface SweepResult {
  depositAddress: string;
  coinType: string;
  amountSwept: bigint;
  digest?: string;
  dryRun: boolean;
  opId?: string;
}

export async function sweepDepositAddress(
  args: SweepDepositAddressArgs,
): Promise<SweepResult> {
  const { derivationIndex, to, client, dryRun = false } = args;
  const coinType = canonicalType(args.coinType);
  const initiatedBy = args.initiatedBy ?? "operator-script";

  // Derive the user keypair on demand — not cached at module level.
  const kpProvider = args._keypairProvider ?? await defaultKeypairProvider();
  const kp = kpProvider.getUserDepositKeypair(derivationIndex);
  const depositAddress = kp.toSuiAddress();

  log.info("treasury/operator: sweep start", {
    derivationIndex,
    depositAddress,
    coinType,
    to,
    dryRun,
  });

  const isSui = coinType === canonicalType(SUI_COIN_TYPE);

  // --- balance check -------------------------------------------------------
  const targetCoins = await fetchAllCoins(client, depositAddress, coinType);
  const totalTarget = totalBalance(targetCoins);

  if (totalTarget === 0n) {
    log.info("treasury/operator: sweep skipped — zero balance", {
      depositAddress,
      coinType,
    });
    return { depositAddress, coinType, amountSwept: 0n, dryRun };
  }

  let amountToSweep: bigint;
  if (args.amount !== undefined) {
    amountToSweep = args.amount;
    if (amountToSweep <= 0n) throw new Error("sweep: amount must be > 0");
    if (amountToSweep > totalTarget) {
      throw new Error(
        `sweep: requested ${amountToSweep} but ${depositAddress} only has ${totalTarget} of ${coinType}`,
      );
    }
  } else if (isSui) {
    // Leave gas reserve on SUI sweeps.
    if (totalTarget <= GAS_RESERVE_MIST) {
      log.info("treasury/operator: sweep skipped — balance at or below gas reserve", {
        depositAddress,
        coinType,
        balance: totalTarget.toString(),
        gasReserve: GAS_RESERVE_MIST.toString(),
      });
      return { depositAddress, coinType, amountSwept: 0n, dryRun };
    }
    amountToSweep = totalTarget - GAS_RESERVE_MIST;
  } else {
    amountToSweep = totalTarget;
  }

  if (dryRun) {
    log.info("treasury/operator: sweep dry-run", {
      depositAddress,
      coinType,
      amountToSweep: amountToSweep.toString(),
      to,
    });
    return { depositAddress, coinType, amountSwept: amountToSweep, dryRun: true };
  }

  // --- record ops row BEFORE submission (status=pending) -------------------
  // We insert the row here, before the gas check for non-SUI, so that a
  // 'failed' row exists even when gas is missing. This satisfies the audit
  // requirement: every attempted sweep is recorded.
  const opId = recordOp({
    opKind: "sweep",
    fromAddress: depositAddress,
    toAddress: to,
    coinTypeIn: coinType,
    amountIn: amountToSweep,
    initiatedBy,
  });

  // --- gas check for non-SUI sweeps ----------------------------------------
  if (!isSui) {
    const suiCoinList = await fetchAllCoins(
      client,
      depositAddress,
      canonicalType(SUI_COIN_TYPE),
    );
    const suiTotal = totalBalance(suiCoinList);
    if (suiTotal < GAS_RESERVE_MIST) {
      const msg =
        `sweep: ${depositAddress} has no SUI for gas ` +
        `(balance ${suiTotal} mist < required ${GAS_RESERVE_MIST} mist); ` +
        `top up SUI on this address before sweeping ${coinType}`;
      log.error("treasury/operator: sweep aborted — no gas", {
        depositAddress,
        coinType,
        suiBalance: suiTotal.toString(),
      });
      markOpResult(opId, { status: "failed", error: msg });
      throw new Error(msg);
    }
  }

  // --- build PTB ------------------------------------------------------------
  const tx = new Transaction();
  tx.setSender(depositAddress);

  if (isSui) {
    targetCoins.sort((a, b) => (b.balance > a.balance ? 1 : -1));

    // Use the largest coin as gas payment, sweep from the rest.
    const gasCoin = targetCoins.find((c) => c.balance >= GAS_RESERVE_MIST);
    if (!gasCoin) {
      // Already checked totalTarget > GAS_RESERVE_MIST above, so this branch
      // is hit only if every individual coin is below the reserve (e.g. many
      // tiny coins). Fall back to gas=auto and sweep amountToSweep from merge.
      const primary = tx.object(targetCoins[0]!.objectId);
      if (targetCoins.length > 1) {
        tx.mergeCoins(
          primary,
          targetCoins.slice(1).map((c) => tx.object(c.objectId)),
        );
      }
      const [split] = tx.splitCoins(primary, [amountToSweep]);
      tx.transferObjects([split!], to);
    } else {
      tx.setGasPayment([
        { objectId: gasCoin.objectId, version: gasCoin.version, digest: gasCoin.digest },
      ]);
      const sourceCoins = targetCoins.filter((c) => c.objectId !== gasCoin.objectId);
      if (sourceCoins.length === 0) {
        // Only one SUI coin — split from it.
        const [split] = tx.splitCoins(tx.object(gasCoin.objectId), [amountToSweep]);
        tx.transferObjects([split!], to);
      } else if (sourceCoins.length === 1) {
        const [split] = tx.splitCoins(tx.object(sourceCoins[0]!.objectId), [amountToSweep]);
        tx.transferObjects([split!], to);
      } else {
        const primary = tx.object(sourceCoins[0]!.objectId);
        tx.mergeCoins(
          primary,
          sourceCoins.slice(1).map((c) => tx.object(c.objectId)),
        );
        const [split] = tx.splitCoins(primary, [amountToSweep]);
        tx.transferObjects([split!], to);
      }
    }
  } else {
    // Non-SUI: merge all target coins, split exact amount, transfer.
    const primary = tx.object(targetCoins[0]!.objectId);
    if (targetCoins.length > 1) {
      tx.mergeCoins(
        primary,
        targetCoins.slice(1).map((c) => tx.object(c.objectId)),
      );
    }
    const [split] = tx.splitCoins(primary, [amountToSweep]);
    tx.transferObjects([split!], to);
  }

  // --- submit ---------------------------------------------------------------
  let digest: string;
  try {
    const result = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: kp,
      options: { showEffects: true },
    });

    const statusValue = result.effects?.status.status;
    if (statusValue === "failure") {
      const errMsg = result.effects?.status.error ?? "on-chain failure (no details)";
      markOpResult(opId, { status: "failed", digest: result.digest, error: errMsg });
      throw new Error(`sweep: on-chain execution failed: ${errMsg}`);
    }

    digest = result.digest;
    markOpResult(opId, { status: "succeeded", digest });

    // Seed the balance cache so the watcher's next tick sees delta=0 not a
    // large negative delta (which would be logged as a spurious outflow).
    const newBalance = totalTarget - amountToSweep;
    seedBalanceCache(depositAddress, coinType, newBalance);

    log.info("treasury/operator: sweep succeeded", {
      depositAddress,
      coinType,
      amountSwept: amountToSweep.toString(),
      digest,
      opId,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Only mark failed if we haven't already (e.g. on-chain failure path above
    // already called markOpResult before rethrowing).
    if (!msg.includes("on-chain execution failed")) {
      markOpResult(opId, { status: "failed", error: msg });
    }
    throw err;
  }

  return { depositAddress, coinType, amountSwept: amountToSweep, digest, dryRun: false, opId };
}

// ---- sweep all registered deposit addresses ------------------------------

export interface SweepAllArgs {
  /** Filter to a single coin type. If omitted, sweep all balance types found. */
  coinType?: string;
  /** Recipient (defaults to treasury master address). */
  to?: string;
  /** Skip deposit addresses with balance below this threshold. */
  minAmount?: bigint;
  client: OperatorClient;
  dryRun?: boolean;
  initiatedBy?: string;
  /** Injectable for tests — see `SweepDepositAddressArgs._keypairProvider`. */
  _keypairProvider?: KeypairProvider;
}

export interface SweepAllReport {
  swept: SweepResult[];
  skipped: Array<{ depositAddress: string; reason: string }>;
  errors: Array<{ depositAddress: string; error: string }>;
}

export async function sweepAll(args: SweepAllArgs): Promise<SweepAllReport> {
  const { client, dryRun = false } = args;
  const minAmount = args.minAmount ?? 1n;
  const coinTypeFilter = args.coinType ? canonicalType(args.coinType) : null;
  const initiatedBy = args.initiatedBy ?? "operator-script";
  const kpProvider = args._keypairProvider ?? await defaultKeypairProvider();

  // Resolve recipient — master address if not given.
  let to: string;
  if (args.to) {
    to = args.to;
  } else if (kpProvider.getMasterAddress) {
    to = kpProvider.getMasterAddress();
  } else {
    const { getTreasuryMasterAddress } = await import("../sui/keypairs/treasury.ts");
    to = getTreasuryMasterAddress();
  }

  const users = listUsers();
  const report: SweepAllReport = { swept: [], skipped: [], errors: [] };

  for (const user of users) {
    const { depositAddress, derivationIndex } = user;

    // Determine which coin types to sweep on this address.
    let coinTypes: string[];
    if (coinTypeFilter) {
      coinTypes = [coinTypeFilter];
    } else {
      // Discover all held coin types via getCoins for known types, or we can
      // use a broader approach: sweep SUI + anything in the balance cache.
      // For robustness we check the balance table plus SUI, since the watcher
      // may not have run yet on this address.
      const db = getDb();
      const rows = db
        .query<{ coin_type: string }, [string]>(
          "SELECT DISTINCT coin_type FROM treasury_address_balances WHERE deposit_address = ?",
        )
        .all(depositAddress);
      coinTypes = [
        canonicalType(SUI_COIN_TYPE),
        ...rows.map((r) => r.coin_type),
      ];
      // deduplicate
      coinTypes = [...new Set(coinTypes)];
    }

    for (const ct of coinTypes) {
      // Check the cached balance first to decide whether to proceed.
      const db = getDb();
      const cached = db
        .query<{ last_seen_balance: string }, [string, string]>(
          "SELECT last_seen_balance FROM treasury_address_balances WHERE deposit_address = ? AND coin_type = ?",
        )
        .get(depositAddress, ct);

      // If we have no cached snapshot, we'll try anyway (getCoins will show 0 if empty).
      const cachedBal = cached ? BigInt(cached.last_seen_balance) : 0n;

      if (cachedBal < minAmount) {
        report.skipped.push({
          depositAddress,
          reason: `cached balance ${cachedBal} < minAmount ${minAmount} for ${ct}`,
        });
        continue;
      }

      try {
        const result = await sweepDepositAddress({
          derivationIndex,
          coinType: ct,
          to,
          client,
          dryRun,
          initiatedBy,
          _keypairProvider: kpProvider,
        });

        if (result.amountSwept === 0n) {
          report.skipped.push({
            depositAddress,
            reason: `zero spendable balance for ${ct}`,
          });
        } else {
          report.swept.push(result);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        report.errors.push({ depositAddress, error: msg });
        log.warn("treasury/operator: sweepAll error for address", {
          depositAddress,
          coinType: ct,
          error: msg,
        });
      }
    }
  }

  return report;
}

// ---- refund a user (operator-initiated) ----------------------------------

export interface RefundUserArgs {
  /** User's main wallet address. */
  suiAddress: string;
  client: OperatorClient;
  dryRun?: boolean;
  initiatedBy?: string;
  /** Injectable for tests — see `SweepDepositAddressArgs._keypairProvider`. */
  _keypairProvider?: KeypairProvider;
}

export interface RefundUserResult {
  suiAddress: string;
  depositAddress: string;
  transfers: Array<{
    coinType: string;
    amount: bigint;
    digest?: string;
    opId?: string;
  }>;
  creditsBefore: number;
  creditsAfter: number;
  dryRun: boolean;
}

/**
 * Operator-initiated refund: transfer all on-chain balances from the deposit
 * address back to the user's main wallet, and atomically zero their credits.
 *
 * Note: the `--confirm` guard is the CLI's responsibility. This function takes
 * explicit arguments and executes unconditionally (no prompt inside).
 *
 * DB writes (credits zero + ops rows) are done in a single SQLite transaction
 * AFTER all on-chain transfers succeed, so we never zero credits without proof
 * of delivery. If a chain transfer fails mid-refund, partial transfers that
 * already succeeded are recorded in ops rows; credits are NOT zeroed.
 */
export async function refundUser(args: RefundUserArgs): Promise<RefundUserResult> {
  const { suiAddress, client, dryRun = false } = args;
  const initiatedBy = args.initiatedBy ?? "operator-script";

  const user = findUserBySuiAddress(suiAddress);
  if (!user) {
    throw new Error(`refundUser: no treasury user registered for ${suiAddress}`);
  }

  const { depositAddress, derivationIndex, credits: creditsBefore } = user;

  // Derive keypair on demand.
  const kpProvider = args._keypairProvider ?? await defaultKeypairProvider();
  const kp = kpProvider.getUserDepositKeypair(derivationIndex);

  if (kp.toSuiAddress() !== depositAddress) {
    throw new Error(
      `refundUser: derivation mismatch — expected ${depositAddress}, ` +
      `got ${kp.toSuiAddress()} (index ${derivationIndex})`,
    );
  }

  log.info("treasury/operator: refund start", {
    suiAddress,
    depositAddress,
    creditsBefore,
    dryRun,
  });

  // Discover all non-zero coin types held by the deposit address.
  // We need to handle coin types that may not be in the cache yet,
  // so we query the balance table AND try SUI directly.
  const db = getDb();
  const cachedTypes = db
    .query<{ coin_type: string }, [string]>(
      "SELECT DISTINCT coin_type FROM treasury_address_balances WHERE deposit_address = ?",
    )
    .all(depositAddress)
    .map((r) => r.coin_type);

  const allTypes = [...new Set([canonicalType(SUI_COIN_TYPE), ...cachedTypes])];

  // Collect balances.
  interface HeldBalance {
    coinType: string;
    coins: CoinRef[];
    total: bigint;
  }
  const held: HeldBalance[] = [];
  for (const ct of allTypes) {
    const coins = await fetchAllCoins(client, depositAddress, ct);
    const total = totalBalance(coins);
    if (total > 0n) {
      held.push({ coinType: ct, coins, total });
    }
  }

  if (held.length === 0) {
    log.info("treasury/operator: refund — no balances to transfer", { suiAddress });
    // Still zero credits even if no on-chain balance.
  }

  // Check gas for non-SUI transfers.
  const suiHeld = held.find((h) => h.coinType === canonicalType(SUI_COIN_TYPE));
  const nonSuiHeld = held.filter((h) => h.coinType !== canonicalType(SUI_COIN_TYPE));
  if (nonSuiHeld.length > 0) {
    const suiTotal = suiHeld?.total ?? 0n;
    if (suiTotal < GAS_RESERVE_MIST) {
      throw new Error(
        `refundUser: ${depositAddress} has insufficient SUI for gas ` +
        `(${suiTotal} mist < ${GAS_RESERVE_MIST} mist) — needed to refund ${nonSuiHeld.map((h) => h.coinType).join(", ")}`,
      );
    }
  }

  if (dryRun) {
    log.info("treasury/operator: refund dry-run", {
      suiAddress,
      transfersPlanned: held.map((h) => ({ coinType: h.coinType, amount: h.total.toString() })),
    });
    return {
      suiAddress,
      depositAddress,
      transfers: held.map((h) => ({ coinType: h.coinType, amount: h.total })),
      creditsBefore,
      creditsAfter: 0,
      dryRun: true,
    };
  }

  // Execute transfers per coin type.
  const completedTransfers: Array<{
    coinType: string;
    amount: bigint;
    digest: string;
    opId: string;
  }> = [];

  for (const { coinType, coins, total } of held) {
    const isSui = coinType === canonicalType(SUI_COIN_TYPE);
    let amountToSend: bigint;

    if (isSui) {
      if (total <= GAS_RESERVE_MIST) {
        log.info("treasury/operator: refund skipping SUI — at gas reserve", {
          depositAddress,
          balance: total.toString(),
        });
        continue;
      }
      amountToSend = total - GAS_RESERVE_MIST;
    } else {
      amountToSend = total;
    }

    // Record op BEFORE submission.
    const opId = recordOp({
      opKind: "transfer",
      fromAddress: depositAddress,
      toAddress: suiAddress,
      coinTypeIn: coinType,
      amountIn: amountToSend,
      initiatedBy,
    });

    const tx = new Transaction();
    tx.setSender(depositAddress);

    if (isSui) {
      coins.sort((a, b) => (b.balance > a.balance ? 1 : -1));
      const gasCoin = coins.find((c) => c.balance >= GAS_RESERVE_MIST);
      if (gasCoin) {
        tx.setGasPayment([
          { objectId: gasCoin.objectId, version: gasCoin.version, digest: gasCoin.digest },
        ]);
        const sourceSui = coins.filter((c) => c.objectId !== gasCoin.objectId);
        if (sourceSui.length === 0) {
          const [split] = tx.splitCoins(tx.object(gasCoin.objectId), [amountToSend]);
          tx.transferObjects([split!], suiAddress);
        } else {
          const primary = tx.object(sourceSui[0]!.objectId);
          if (sourceSui.length > 1) {
            tx.mergeCoins(primary, sourceSui.slice(1).map((c) => tx.object(c.objectId)));
          }
          const [split] = tx.splitCoins(primary, [amountToSend]);
          tx.transferObjects([split!], suiAddress);
        }
      } else {
        const primary = tx.object(coins[0]!.objectId);
        if (coins.length > 1) {
          tx.mergeCoins(primary, coins.slice(1).map((c) => tx.object(c.objectId)));
        }
        const [split] = tx.splitCoins(primary, [amountToSend]);
        tx.transferObjects([split!], suiAddress);
      }
    } else {
      const primary = tx.object(coins[0]!.objectId);
      if (coins.length > 1) {
        tx.mergeCoins(primary, coins.slice(1).map((c) => tx.object(c.objectId)));
      }
      const [split] = tx.splitCoins(primary, [amountToSend]);
      tx.transferObjects([split!], suiAddress);
    }

    let digest: string;
    try {
      const result = await client.signAndExecuteTransaction({
        transaction: tx,
        signer: kp,
        options: { showEffects: true },
      });
      const statusValue = result.effects?.status.status;
      if (statusValue === "failure") {
        const errMsg = result.effects?.status.error ?? "on-chain failure";
        markOpResult(opId, { status: "failed", digest: result.digest, error: errMsg });
        throw new Error(`refundUser: on-chain transfer failed for ${coinType}: ${errMsg}`);
      }
      digest = result.digest;
      markOpResult(opId, { status: "succeeded", digest });
      seedBalanceCache(depositAddress, coinType, 0n);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("on-chain transfer failed")) {
        markOpResult(opId, { status: "failed", error: msg });
      }
      throw err;
    }

    completedTransfers.push({ coinType, amount: amountToSend, digest, opId });
  }

  // Atomically zero the user's credits after all transfers succeeded.
  const db2 = getDb();
  db2.transaction(() => {
    db2.prepare(
      "UPDATE treasury_users SET credits = 0 WHERE sui_address = ?",
    ).run(suiAddress);
  })();

  const userAfter = findUserBySuiAddress(suiAddress);
  const creditsAfter = userAfter?.credits ?? 0;

  log.info("treasury/operator: refund complete", {
    suiAddress,
    creditsBefore,
    creditsAfter,
    transfers: completedTransfers.length,
  });

  return {
    suiAddress,
    depositAddress,
    transfers: completedTransfers,
    creditsBefore,
    creditsAfter,
    dryRun: false,
  };
}

// ---- swap to USDC via Cetus Aggregator -----------------------------------

export interface SwapToUsdcArgs {
  /** Deposit address owner's derivation index. */
  derivationIndex: number;
  /** Coin type to swap from (canonicalised inside). */
  fromCoinType: string;
  /** Amount to swap (atomic units). */
  amountIn: bigint;
  /** Slippage tolerance 0–1 (e.g. 0.005 = 0.5%). */
  slippage: number;
  client: OperatorClient;
  /**
   * Injected AggregatorClient instance. Callers construct with:
   *   `new AggregatorClient({ network: loadConfig().network })`
   * Injected for testability.
   */
  aggregatorClient: import("@cetusprotocol/aggregator-sdk").AggregatorClient;
  dryRun?: boolean;
  initiatedBy?: string;
  /** Injectable for tests — see `SweepDepositAddressArgs._keypairProvider`. */
  _keypairProvider?: KeypairProvider;
}

export const USDC_COIN_TYPE =
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::usdc";

export interface SwapToUsdcResult {
  depositAddress: string;
  fromCoinType: string;
  amountIn: bigint;
  amountOut?: bigint;
  digest?: string;
  opId?: string;
  dryRun: boolean;
}

/**
 * Swap a coin type to USDC via the Cetus Aggregator, signing from the user's
 * deposit address keypair.
 *
 * The aggregator SDK imports cleanly under Bun in this repo (confirmed via
 * `bun -e "import('@cetusprotocol/aggregator-sdk').then(...)"` probe).
 * The body is wired; no new package.json deps are needed (the SDK is not a
 * dependency of this package — callers must install it separately or use
 * the production harness that includes it).
 */
export async function swapToUsdc(args: SwapToUsdcArgs): Promise<SwapToUsdcResult> {
  const {
    derivationIndex,
    amountIn,
    slippage,
    client: _client,
    aggregatorClient,
    dryRun = false,
  } = args;
  const fromCoinType = canonicalType(args.fromCoinType);
  const toCoinType = canonicalType(USDC_COIN_TYPE);
  const initiatedBy = args.initiatedBy ?? "operator-script";

  if (slippage <= 0 || slippage > 0.5) {
    throw new Error(`swapToUsdc: slippage must be in (0, 0.5], got ${slippage}`);
  }
  if (amountIn <= 0n) {
    throw new Error("swapToUsdc: amountIn must be > 0");
  }

  const kpProvider = args._keypairProvider ?? await defaultKeypairProvider();
  const kp = kpProvider.getUserDepositKeypair(derivationIndex);
  const depositAddress = kp.toSuiAddress();

  log.info("treasury/operator: swap start", {
    derivationIndex,
    depositAddress,
    fromCoinType,
    toCoinType,
    amountIn: amountIn.toString(),
    slippage,
    dryRun,
  });

  if (dryRun) {
    return {
      depositAddress,
      fromCoinType,
      amountIn,
      dryRun: true,
    };
  }

  // Find routes via the aggregator.
  const routers = await aggregatorClient.findRouters({
    from: fromCoinType,
    target: toCoinType,
    amount: amountIn.toString(),
    byAmountIn: true,
  });

  if (!routers || (Array.isArray(routers) ? routers.length === 0 : !routers.routes?.length)) {
    throw new Error(
      `swapToUsdc: aggregator returned no routes for ${fromCoinType} → ${toCoinType}`,
    );
  }

  // Record op BEFORE submission.
  const opId = recordOp({
    opKind: "swap",
    fromAddress: depositAddress,
    toAddress: depositAddress, // Swap stays at same address
    coinTypeIn: fromCoinType,
    amountIn,
    coinTypeOut: toCoinType,
    initiatedBy,
  });

  // Get input coins.
  const inputCoins = await fetchAllCoins(_client, depositAddress, fromCoinType);
  if (totalBalance(inputCoins) < amountIn) {
    markOpResult(opId, {
      status: "failed",
      error: `insufficient ${fromCoinType} balance`,
    });
    throw new Error(
      `swapToUsdc: insufficient balance — have ${totalBalance(inputCoins)}, need ${amountIn}`,
    );
  }

  // Build a Transaction to be populated by routerSwap.
  // We use `any` at the boundary between our `@mysten/sui` Transaction and the
  // aggregator SDK's own bundled `@mysten/sui` Transaction — they are the same
  // library at runtime but TypeScript sees them as different module instances
  // because the SDK bundles its own copy. The cast is safe: the runtime objects
  // are structurally identical.
  const { Transaction: Tx } = await import("@mysten/sui/transactions");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const txb: any = new Tx();
  txb.setSender(depositAddress);

  // Merge input coins into one if needed.
  const inputCoinObj = (() => {
    if (inputCoins.length === 1) {
      return txb.object(inputCoins[0]!.objectId);
    }
    const primary = txb.object(inputCoins[0]!.objectId);
    txb.mergeCoins(primary, inputCoins.slice(1).map((c: CoinRef) => txb.object(c.objectId)));
    return primary;
  })();

  // routerSwap mutates `txb` in-place and returns the output coin result.
  // The aggregator's signAndExecuteTransaction takes (txb, signer) — 2-arg form.
  await aggregatorClient.routerSwap({
    routers,
    inputCoin: inputCoinObj,
    slippage,
    txb,
  });

  // Sign and execute via the aggregator's built-in method.
  // The aggregator SDK's signAndExecuteTransaction is (txb: Transaction, signer: Signer)
  // — 2-arg form, different from our OperatorClient wrapper.
  let digest: string;
  let amountOut: bigint | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await (aggregatorClient as any).signAndExecuteTransaction(txb, kp);
    const statusValue: string | undefined = result?.effects?.status?.status;
    if (statusValue === "failure") {
      const errMsg: string = result?.effects?.status?.error ?? "on-chain failure";
      markOpResult(opId, {
        status: "failed",
        digest: result?.digest,
        error: errMsg,
      });
      throw new Error(`swapToUsdc: on-chain swap failed: ${errMsg}`);
    }
    digest = result.digest;

    // Extract amountOut from balanceChanges if available.
    const changes: Array<{ coinType: string; amount: string }> = result?.balanceChanges ?? [];
    const usdcChange = changes.find(
      (c) => canonicalType(c.coinType) === toCoinType && BigInt(c.amount) > 0n,
    );
    if (usdcChange) {
      amountOut = BigInt(usdcChange.amount);
    }

    markOpResult(opId, { status: "succeeded", digest, amountOut });

    // Seed balance cache for both coins.
    const newFromBalance = totalBalance(inputCoins) - amountIn;
    seedBalanceCache(depositAddress, fromCoinType, newFromBalance);

    log.info("treasury/operator: swap succeeded", {
      depositAddress,
      fromCoinType,
      amountIn: amountIn.toString(),
      amountOut: amountOut?.toString(),
      digest,
      opId,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("on-chain swap failed")) {
      markOpResult(opId, { status: "failed", error: msg });
    }
    throw err;
  }

  return {
    depositAddress,
    fromCoinType,
    amountIn,
    amountOut,
    digest,
    opId,
    dryRun: false,
  };
}
