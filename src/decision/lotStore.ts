/**
 * Lot store — persistence + carry-forward bookkeeping for the age stop-loss.
 *
 * THE TRAP this module exists to avoid: `diffPlan` rebuilds the whole
 * position on every rebalance (remove-all + re-add). If each re-add simply
 * created fresh lots, every lot's age would reset every rebalance and the
 * 4h/12h stop-loss thresholds (ageStopLoss.ts) could NEVER fire while the
 * bot rebalances more often than 4 hours — i.e. always. So re-added amounts
 * up to the previously-open total CARRY the earliest acquiredAtMs and a
 * value-weighted cost basis forward; only the excess becomes a new lot.
 *
 * Model (v1, deliberately coarse): ONE open lot per physical side per PM.
 *   - side 'A' = physical coinA (bins above active), 'B' = coinB (below).
 *   - The lot's binId is the side's largest-amount bin from the latest plan —
 *     a representative parking bin used only for ageStopLoss mark-to-market.
 *   - A side that re-adds nothing closes its lots (the inventory moved to
 *     idle/lending and is no longer at LP risk in this model).
 *
 * Cost basis and prices are HUMAN pair prices (quote-per-base).
 */

import type { Database } from "bun:sqlite";
import type { RebalancePlan } from "../domain/types.ts";
import type { LotRecord } from "./ageStopLoss.ts";
import { log } from "../lib/logger.ts";

interface LotRow {
  id: number;
  side: "A" | "B";
  bin_id: number;
  acquired_at_ms: number;
  cost_basis: number;
  amount: string;
}

export interface OpenLot extends LotRecord {
  side: "A" | "B";
}

/** Load the PM's open lots in ageStopLoss.LotRecord shape (+side). */
export function loadOpenLots(db: Database, pmId: string): OpenLot[] {
  const rows = db
    .prepare<LotRow, [string]>(
      `SELECT id, side, bin_id, acquired_at_ms, cost_basis, amount
       FROM position_lots WHERE pm_id = ? AND status = 'open'
       ORDER BY acquired_at_ms ASC`,
    )
    .all(pmId);
  return rows.map((r) => ({
    side: r.side,
    binId: r.bin_id,
    acquiredAtMs: r.acquired_at_ms,
    costBasis: r.cost_basis,
    amount: BigInt(r.amount),
  }));
}

/** Per-side totals + weighted aggregates over the open lots. */
function aggregateSide(lots: OpenLot[], side: "A" | "B"): {
  total: bigint;
  earliestMs: number | null;
  weightedCost: number;
} {
  const sideLots = lots.filter((l) => l.side === side);
  let total = 0n;
  let earliestMs: number | null = null;
  let costNum = 0;
  for (const l of sideLots) {
    total += l.amount;
    if (earliestMs === null || l.acquiredAtMs < earliestMs) earliestMs = l.acquiredAtMs;
    costNum += l.costBasis * Number(l.amount);
  }
  const weightedCost = total > 0n ? costNum / Number(total) : 0;
  return { total, earliestMs, weightedCost };
}

/** The plan's per-side re-added totals + the side's largest-amount bin. */
function planSide(plan: RebalancePlan, side: "A" | "B"): { total: bigint; repBin: number | null } {
  const amounts = side === "A" ? plan.addAmountsA : plan.addAmountsB;
  let total = 0n;
  let repBin: number | null = null;
  let repAmount = -1n;
  for (let i = 0; i < plan.addBins.length; i++) {
    const v = amounts[i] ?? 0n;
    total += v;
    if (v > repAmount) {
      repAmount = v;
      repBin = plan.addBins[i]!;
    }
  }
  return { total, repBin: repAmount > 0n ? repBin : null };
}

/**
 * Reconcile the lot book with a SUCCEEDED rebalance.
 *
 * Per side:
 *   - carried = min(open total, re-added total) keeps the earliest
 *     acquiredAtMs + value-weighted cost basis, re-parked at the side's new
 *     representative bin;
 *   - excess re-add (> open total) becomes a NEW lot at (nowMs, spotPrice);
 *   - a side with zero re-add closes out entirely.
 *
 * All previous open rows are closed and replaced by at most two rows per side
 * (carried + new). Runs in a transaction.
 *
 * @param spotHumanPrice current human pair price (quote-per-base) — the cost
 *                       basis for newly-acquired amounts.
 */
export function syncLotsAfterRebalance(
  db: Database,
  pmId: string,
  plan: RebalancePlan,
  spotHumanPrice: number,
  nowMs: number,
): void {
  const open = loadOpenLots(db, pmId);

  const insert = db.prepare(
    `INSERT INTO position_lots
       (pm_id, side, bin_id, acquired_at_ms, cost_basis, amount, status, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
  );
  const closeAll = db.prepare(
    `UPDATE position_lots SET status = 'closed', closed_at_ms = ?
     WHERE pm_id = ? AND status = 'open'`,
  );

  const tx = db.transaction(() => {
    closeAll.run(nowMs, pmId);

    for (const side of ["A", "B"] as const) {
      const prev = aggregateSide(open, side);
      const now = planSide(plan, side);
      if (now.total === 0n || now.repBin === null) continue; // side closed out

      const carried = prev.total < now.total ? prev.total : now.total;
      const fresh = now.total - carried;

      if (carried > 0n && prev.earliestMs !== null) {
        insert.run(
          pmId, side, now.repBin, prev.earliestMs, prev.weightedCost,
          carried.toString(), nowMs,
        );
      }
      if (fresh > 0n) {
        insert.run(
          pmId, side, now.repBin, nowMs, spotHumanPrice,
          fresh.toString(), nowMs,
        );
      }
    }
  });
  tx();

  log.debug("lotStore: synced lots after rebalance", {
    pmId,
    prevOpen: open.length,
    addBins: plan.addBins.length,
  });
}
