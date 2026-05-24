/**
 * SQLite access layer for all `treasury_*` tables. Pure CRUD — no derivation,
 * no LLM calls, no network. Uses `getDb()` for connection access, wraps writes
 * in transactions where multi-row consistency matters.
 *
 * Caller invariants:
 *   - `coinType` values passed in must already be canonicalised via
 *     `canonicalType()` from `src/sui/lending/typeNorm.ts` (so `0x2::sui::SUI`
 *     and `0x0000…02::sui::SUI` are stored as the same key).
 *   - All bigints serialise to TEXT (SQLite has no native bigint).
 */

import { getDb } from "../db/client.ts";
import type {
  AddressBalanceSnapshot,
  CreditRate,
  DepositRecord,
  ServiceCharge,
  ServiceChargeStatus,
  TreasuryOp,
  TreasuryUser,
} from "./types.ts";

// ---- helpers -----------------------------------------------------------

function bn(s: string | null | undefined): bigint {
  return BigInt(s ?? "0");
}

// ---- users -------------------------------------------------------------

interface UserRow {
  sui_address: string;
  derivation_index: number;
  deposit_address: string;
  credits: number;
  created_at_ms: number;
}

function rowToUser(r: UserRow): TreasuryUser {
  return {
    suiAddress: r.sui_address,
    derivationIndex: r.derivation_index,
    depositAddress: r.deposit_address,
    credits: r.credits,
    createdAtMs: r.created_at_ms,
  };
}

/** Atomic registration: returns existing user when sui_address already registered. */
export function registerUserTx(
  suiAddress: string,
  deriveAddress: (index: number) => string,
  nowMs: number = Date.now(),
): TreasuryUser {
  const db = getDb();
  return db.transaction(() => {
    const existing = db
      .query<UserRow, [string]>(
        "SELECT * FROM treasury_users WHERE sui_address = ?",
      )
      .get(suiAddress);
    if (existing) return rowToUser(existing);

    const maxRow = db
      .query<{ max_idx: number | null }, []>(
        "SELECT MAX(derivation_index) AS max_idx FROM treasury_users",
      )
      .get();
    const nextIndex = (maxRow?.max_idx ?? 0) + 1;
    const depositAddress = deriveAddress(nextIndex);

    db.prepare(
      `INSERT INTO treasury_users
        (sui_address, derivation_index, deposit_address, credits, created_at_ms)
       VALUES (?, ?, ?, 0, ?)`,
    ).run(suiAddress, nextIndex, depositAddress, nowMs);

    return {
      suiAddress,
      derivationIndex: nextIndex,
      depositAddress,
      credits: 0,
      createdAtMs: nowMs,
    };
  })();
}

export function findUserBySuiAddress(suiAddress: string): TreasuryUser | null {
  const db = getDb();
  const row = db
    .query<UserRow, [string]>(
      "SELECT * FROM treasury_users WHERE sui_address = ?",
    )
    .get(suiAddress);
  return row ? rowToUser(row) : null;
}

export function findUserByDepositAddress(
  depositAddress: string,
): TreasuryUser | null {
  const db = getDb();
  const row = db
    .query<UserRow, [string]>(
      "SELECT * FROM treasury_users WHERE deposit_address = ?",
    )
    .get(depositAddress);
  return row ? rowToUser(row) : null;
}

export function listUsers(): TreasuryUser[] {
  const db = getDb();
  return db
    .query<UserRow, []>(
      "SELECT * FROM treasury_users ORDER BY derivation_index ASC",
    )
    .all()
    .map(rowToUser);
}

// ---- credit rates ------------------------------------------------------

interface RateRow {
  coin_type: string;
  rate_num: string;
  rate_den: string;
  updated_at_ms: number;
  updated_by: string | null;
}

function rowToRate(r: RateRow): CreditRate {
  return {
    coinType: r.coin_type,
    rateNum: bn(r.rate_num),
    rateDen: bn(r.rate_den),
    updatedAtMs: r.updated_at_ms,
    updatedBy: r.updated_by,
  };
}

export function getCreditRate(coinType: string): CreditRate | null {
  const db = getDb();
  const row = db
    .query<RateRow, [string]>(
      "SELECT * FROM treasury_credit_rates WHERE coin_type = ?",
    )
    .get(coinType);
  return row ? rowToRate(row) : null;
}

export function listCreditRates(): CreditRate[] {
  const db = getDb();
  return db
    .query<RateRow, []>(
      "SELECT * FROM treasury_credit_rates ORDER BY coin_type ASC",
    )
    .all()
    .map(rowToRate);
}

export function upsertCreditRate(args: {
  coinType: string;
  rateNum: bigint;
  rateDen: bigint;
  updatedBy?: string | null;
  nowMs?: number;
}): void {
  if (args.rateDen <= 0n) {
    throw new Error("upsertCreditRate: rateDen must be > 0");
  }
  if (args.rateNum < 0n) {
    throw new Error("upsertCreditRate: rateNum must be ≥ 0");
  }
  const db = getDb();
  db.prepare(
    `INSERT INTO treasury_credit_rates
       (coin_type, rate_num, rate_den, updated_at_ms, updated_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(coin_type) DO UPDATE SET
       rate_num      = excluded.rate_num,
       rate_den      = excluded.rate_den,
       updated_at_ms = excluded.updated_at_ms,
       updated_by    = excluded.updated_by`,
  ).run(
    args.coinType,
    args.rateNum.toString(),
    args.rateDen.toString(),
    args.nowMs ?? Date.now(),
    args.updatedBy ?? null,
  );
}

// ---- address balances --------------------------------------------------

interface BalRow {
  deposit_address: string;
  coin_type: string;
  last_seen_balance: string;
  last_seen_ms: number;
}

export function getAddressBalance(
  depositAddress: string,
  coinType: string,
): AddressBalanceSnapshot | null {
  const db = getDb();
  const row = db
    .query<BalRow, [string, string]>(
      `SELECT * FROM treasury_address_balances
       WHERE deposit_address = ? AND coin_type = ?`,
    )
    .get(depositAddress, coinType);
  if (!row) return null;
  return {
    depositAddress: row.deposit_address,
    coinType: row.coin_type,
    lastSeenBalance: bn(row.last_seen_balance),
    lastSeenMs: row.last_seen_ms,
  };
}

export function upsertAddressBalance(snap: AddressBalanceSnapshot): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO treasury_address_balances
       (deposit_address, coin_type, last_seen_balance, last_seen_ms)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(deposit_address, coin_type) DO UPDATE SET
       last_seen_balance = excluded.last_seen_balance,
       last_seen_ms      = excluded.last_seen_ms`,
  ).run(
    snap.depositAddress,
    snap.coinType,
    snap.lastSeenBalance.toString(),
    snap.lastSeenMs,
  );
}

// ---- deposits ----------------------------------------------------------

interface DepositRow {
  id: string;
  sui_address: string;
  deposit_address: string;
  coin_type: string;
  amount_delta: string;
  prev_balance: string;
  new_balance: string;
  credits_granted: number;
  rate_num: string | null;
  rate_den: string | null;
  observed_at_ms: number;
}

function rowToDeposit(r: DepositRow): DepositRecord {
  return {
    id: r.id,
    suiAddress: r.sui_address,
    depositAddress: r.deposit_address,
    coinType: r.coin_type,
    amountDelta: bn(r.amount_delta),
    prevBalance: bn(r.prev_balance),
    newBalance: bn(r.new_balance),
    creditsGranted: r.credits_granted,
    rateNum: r.rate_num ? bn(r.rate_num) : null,
    rateDen: r.rate_den ? bn(r.rate_den) : null,
    observedAtMs: r.observed_at_ms,
  };
}

/**
 * Atomic: append deposit row + bump user credits + update cache, all in one
 * transaction. Returns the inserted deposit's id. Callers must compute
 * `creditsGranted` via `creditsForAmount()` BEFORE calling.
 */
export function recordDepositTx(args: {
  id: string;
  suiAddress: string;
  depositAddress: string;
  coinType: string;
  amountDelta: bigint;
  prevBalance: bigint;
  newBalance: bigint;
  creditsGranted: number;
  rateNum: bigint | null;
  rateDen: bigint | null;
  observedAtMs: number;
}): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO treasury_deposits
        (id, sui_address, deposit_address, coin_type, amount_delta,
         prev_balance, new_balance, credits_granted, rate_num, rate_den,
         observed_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      args.id,
      args.suiAddress,
      args.depositAddress,
      args.coinType,
      args.amountDelta.toString(),
      args.prevBalance.toString(),
      args.newBalance.toString(),
      args.creditsGranted,
      args.rateNum?.toString() ?? null,
      args.rateDen?.toString() ?? null,
      args.observedAtMs,
    );
    if (args.creditsGranted > 0) {
      db.prepare(
        `UPDATE treasury_users
         SET credits = credits + ?
         WHERE sui_address = ?`,
      ).run(args.creditsGranted, args.suiAddress);
    }
    db.prepare(
      `INSERT INTO treasury_address_balances
         (deposit_address, coin_type, last_seen_balance, last_seen_ms)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(deposit_address, coin_type) DO UPDATE SET
         last_seen_balance = excluded.last_seen_balance,
         last_seen_ms      = excluded.last_seen_ms`,
    ).run(
      args.depositAddress,
      args.coinType,
      args.newBalance.toString(),
      args.observedAtMs,
    );
  })();
}

export function listDepositsForUser(suiAddress: string, limit = 50): DepositRecord[] {
  const db = getDb();
  return db
    .query<DepositRow, [string, number]>(
      `SELECT * FROM treasury_deposits
       WHERE sui_address = ?
       ORDER BY observed_at_ms DESC
       LIMIT ?`,
    )
    .all(suiAddress, limit)
    .map(rowToDeposit);
}

// ---- service charges ---------------------------------------------------

interface ChargeRow {
  nonce: string;
  sui_address: string;
  pm_id: string | null;
  credits_debited: number;
  memo: string | null;
  status: ServiceChargeStatus;
  error: string | null;
  created_at_ms: number;
}

function rowToCharge(r: ChargeRow): ServiceCharge {
  return {
    nonce: r.nonce,
    suiAddress: r.sui_address,
    pmId: r.pm_id,
    creditsDebited: r.credits_debited,
    memo: r.memo,
    status: r.status,
    error: r.error,
    createdAtMs: r.created_at_ms,
  };
}

export function findChargeByNonce(nonce: string): ServiceCharge | null {
  const db = getDb();
  const row = db
    .query<ChargeRow, [string]>(
      "SELECT * FROM treasury_service_charges WHERE nonce = ?",
    )
    .get(nonce);
  return row ? rowToCharge(row) : null;
}

/**
 * Atomic charge attempt: enforces nonce uniqueness via PK, checks credits,
 * decrements on success, all in one transaction. Returns the resulting row.
 *
 * Idempotent on nonce: if the nonce already exists, returns the existing row
 * without modification (rebalancer retries are safe).
 */
export function attemptChargeTx(args: {
  nonce: string;
  suiAddress: string;
  pmId: string | null;
  cost: number;
  memo: string | null;
  nowMs?: number;
}): ServiceCharge {
  if (args.cost < 0 || !Number.isInteger(args.cost)) {
    throw new Error(`attemptChargeTx: cost must be a non-negative integer, got ${args.cost}`);
  }
  const db = getDb();
  const nowMs = args.nowMs ?? Date.now();

  return db.transaction(() => {
    const existing = db
      .query<ChargeRow, [string]>(
        "SELECT * FROM treasury_service_charges WHERE nonce = ?",
      )
      .get(args.nonce);
    if (existing) return rowToCharge(existing);

    const userRow = db
      .query<{ credits: number }, [string]>(
        "SELECT credits FROM treasury_users WHERE sui_address = ?",
      )
      .get(args.suiAddress);

    // Defense-in-depth: rebalancer already gates on registration. If we still
    // see an unregistered user here, return rejection without inserting a row
    // (FK from treasury_service_charges → treasury_users would refuse).
    if (!userRow) {
      return {
        nonce: args.nonce,
        suiAddress: args.suiAddress,
        pmId: args.pmId,
        creditsDebited: 0,
        memo: args.memo ?? null,
        status: "rejected" as const,
        error: "not_registered",
        createdAtMs: nowMs,
      };
    }

    let status: ServiceChargeStatus;
    let error: string | null;
    let debited: number;
    if (userRow.credits < args.cost) {
      status = "rejected" as const;
      error = "insufficient_credits";
      debited = 0;
    } else {
      status = "ok";
      error = null;
      debited = args.cost;
      db.prepare(
        "UPDATE treasury_users SET credits = credits - ? WHERE sui_address = ?",
      ).run(args.cost, args.suiAddress);
    }

    db.prepare(
      `INSERT INTO treasury_service_charges
         (nonce, sui_address, pm_id, credits_debited, memo, status, error, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      args.nonce,
      args.suiAddress,
      args.pmId,
      debited,
      args.memo,
      status,
      error,
      nowMs,
    );

    return {
      nonce: args.nonce,
      suiAddress: args.suiAddress,
      pmId: args.pmId,
      creditsDebited: debited,
      memo: args.memo,
      status,
      error,
      createdAtMs: nowMs,
    };
  })();
}

/**
 * Refund a previously successful charge. Idempotent — already-refunded
 * charges are noop. Returns true when the refund was applied.
 */
export function refundChargeTx(nonce: string, reason: string): boolean {
  const db = getDb();
  return db.transaction(() => {
    const row = db
      .query<ChargeRow, [string]>(
        "SELECT * FROM treasury_service_charges WHERE nonce = ?",
      )
      .get(nonce);
    if (!row) return false;
    if (row.status !== "ok") return false;
    db.prepare(
      "UPDATE treasury_users SET credits = credits + ? WHERE sui_address = ?",
    ).run(row.credits_debited, row.sui_address);
    db.prepare(
      `UPDATE treasury_service_charges
       SET status = 'refunded', error = ?
       WHERE nonce = ?`,
    ).run(reason, nonce);
    return true;
  })();
}

// ---- ops ---------------------------------------------------------------

interface OpRow {
  id: string;
  op_kind: TreasuryOp["opKind"];
  from_address: string;
  to_address: string | null;
  coin_type_in: string;
  amount_in: string;
  coin_type_out: string | null;
  amount_out: string | null;
  digest: string | null;
  status: TreasuryOp["status"];
  error: string | null;
  initiated_by: string;
  created_at_ms: number;
}

export function recordOp(op: TreasuryOp): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO treasury_ops
       (id, op_kind, from_address, to_address, coin_type_in, amount_in,
        coin_type_out, amount_out, digest, status, error, initiated_by, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    op.id,
    op.opKind,
    op.fromAddress,
    op.toAddress,
    op.coinTypeIn,
    op.amountIn.toString(),
    op.coinTypeOut,
    op.amountOut?.toString() ?? null,
    op.digest,
    op.status,
    op.error,
    op.initiatedBy,
    op.createdAtMs,
  );
}
