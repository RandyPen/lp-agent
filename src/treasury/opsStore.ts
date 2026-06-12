/**
 * CRUD for `treasury_ops` — operator sweep / transfer / swap audit trail.
 *
 * This is a separate module from `store.ts` (owned by a concurrent agent) to
 * avoid merge conflicts. All concerns here are strictly ops-table only.
 *
 * Caller invariants:
 *   - `coinType` values must already be canonicalised via `canonicalType()`.
 *   - All bigint amounts serialise to TEXT strings in SQLite.
 *   - IDs follow the same `dep_<ts36>_<rand36>` monotonic format used elsewhere
 *     in this repo (watcher uses the same helper).
 */

import { getDb } from "../db/client.ts";
import type { OpKind, OpStatus, TreasuryOp } from "./types.ts";

// ---- ID generation (mirrors watcher's newDepositId pattern) ---------------

/**
 * Generate a sortable unique id for a treasury_ops row.
 * Format: `op_<base36 timestamp>_<base36 random>` — not a full ULID spec,
 * but monotonic-by-time and collision-resistant at our volume.
 */
export function newOpId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 0xffffffff).toString(36);
  return `op_${ts}_${rand}`;
}

// ---- row mapping ----------------------------------------------------------

interface OpRow {
  id: string;
  op_kind: OpKind;
  from_address: string;
  to_address: string | null;
  coin_type_in: string;
  amount_in: string;
  coin_type_out: string | null;
  amount_out: string | null;
  digest: string | null;
  status: OpStatus;
  error: string | null;
  initiated_by: string;
  created_at_ms: number;
}

function rowToOp(r: OpRow): TreasuryOp {
  return {
    id: r.id,
    opKind: r.op_kind,
    fromAddress: r.from_address,
    toAddress: r.to_address,
    coinTypeIn: r.coin_type_in,
    amountIn: BigInt(r.amount_in),
    coinTypeOut: r.coin_type_out,
    amountOut: r.amount_out !== null ? BigInt(r.amount_out) : null,
    digest: r.digest,
    status: r.status,
    error: r.error,
    initiatedBy: r.initiated_by,
    createdAtMs: r.created_at_ms,
  };
}

// ---- public API -----------------------------------------------------------

export interface RecordOpArgs {
  opKind: OpKind;
  fromAddress: string;
  toAddress: string | null;
  coinTypeIn: string;
  amountIn: bigint;
  coinTypeOut?: string | null;
  amountOut?: bigint | null;
  initiatedBy: string;
  nowMs?: number;
}

/**
 * Insert a new ops row with status='pending'. Returns the generated id.
 * Call this BEFORE submitting the on-chain transaction so the row exists
 * even if the process crashes mid-flight.
 */
export function recordOp(args: RecordOpArgs): string {
  const id = newOpId();
  const db = getDb();
  db.prepare(
    `INSERT INTO treasury_ops
       (id, op_kind, from_address, to_address, coin_type_in, amount_in,
        coin_type_out, amount_out, digest, status, error, initiated_by, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', NULL, ?, ?)`,
  ).run(
    id,
    args.opKind,
    args.fromAddress,
    args.toAddress ?? null,
    args.coinTypeIn,
    args.amountIn.toString(),
    args.coinTypeOut ?? null,
    args.amountOut != null ? args.amountOut.toString() : null,
    args.initiatedBy,
    args.nowMs ?? Date.now(),
  );
  return id;
}

export interface MarkOpResultArgs {
  status: "succeeded" | "failed";
  digest?: string | null;
  amountOut?: bigint | null;
  error?: string | null;
}

/**
 * Update a previously-inserted ops row with the on-chain outcome.
 * Idempotent on status — a row already in a terminal state is not modified.
 */
export function markOpResult(id: string, result: MarkOpResultArgs): void {
  const db = getDb();
  db.prepare(
    `UPDATE treasury_ops
     SET status     = ?,
         digest     = COALESCE(?, digest),
         amount_out = COALESCE(?, amount_out),
         error      = ?
     WHERE id = ? AND status = 'pending'`,
  ).run(
    result.status,
    result.digest ?? null,
    result.amountOut != null ? result.amountOut.toString() : null,
    result.error ?? null,
    id,
  );
}

export interface ListOpsFilter {
  opKind?: OpKind;
  fromAddress?: string;
  status?: OpStatus;
  limit?: number;
}

/** List ops rows, most-recent first. */
export function listOps(filter: ListOpsFilter = {}): TreasuryOp[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (filter.opKind) {
    conditions.push("op_kind = ?");
    params.push(filter.opKind);
  }
  if (filter.fromAddress) {
    conditions.push("from_address = ?");
    params.push(filter.fromAddress);
  }
  if (filter.status) {
    conditions.push("status = ?");
    params.push(filter.status);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limitClause = filter.limit != null ? `LIMIT ${filter.limit}` : "";

  return db
    .query<OpRow, typeof params>(
      `SELECT * FROM treasury_ops ${where} ORDER BY created_at_ms DESC ${limitClause}`,
    )
    .all(...params)
    .map(rowToOp);
}

export function getOpById(id: string): TreasuryOp | null {
  const db = getDb();
  const row = db
    .query<OpRow, [string]>("SELECT * FROM treasury_ops WHERE id = ?")
    .get(id);
  return row ? rowToOp(row) : null;
}
