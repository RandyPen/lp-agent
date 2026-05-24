/**
 * Accessor for the `position_state` table — strategy bookkeeping that has to
 * survive across rebalances. The schema lives in `0003_position_state.sql`.
 *
 * Currently only `fillBoundaryBinId` is used (by BidAsk / OnlyBid / OnlySell
 * strategies in v2). v0 strategies don't read or write to this table.
 */

import { getDb } from "../db/client.ts";

export interface PositionState {
  pmId: string;
  fillBoundaryBinId: number | null;
  strategyName: string | null;
  parametersJson: string | null;
  updatedAtMs: number;
}

interface PositionStateRow {
  pm_id: string;
  fill_boundary_bin_id: number | null;
  strategy_name: string | null;
  parameters_json: string | null;
  updated_at_ms: number;
}

function rowToState(row: PositionStateRow): PositionState {
  return {
    pmId: row.pm_id,
    fillBoundaryBinId: row.fill_boundary_bin_id,
    strategyName: row.strategy_name,
    parametersJson: row.parameters_json,
    updatedAtMs: row.updated_at_ms,
  };
}

export function loadPositionState(pmId: string): PositionState | null {
  const db = getDb();
  const row = db
    .query<PositionStateRow, [string]>(
      `SELECT pm_id, fill_boundary_bin_id, strategy_name, parameters_json, updated_at_ms
       FROM position_state WHERE pm_id = ?`,
    )
    .get(pmId);
  return row ? rowToState(row) : null;
}

export function saveFillBoundary(
  pmId: string,
  fillBoundaryBinId: number | null,
  strategyName: string,
): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO position_state (pm_id, fill_boundary_bin_id, strategy_name, updated_at_ms)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(pm_id) DO UPDATE SET
       fill_boundary_bin_id = excluded.fill_boundary_bin_id,
       strategy_name        = excluded.strategy_name,
       updated_at_ms        = excluded.updated_at_ms`,
  ).run(pmId, fillBoundaryBinId, strategyName, Date.now());
}

export function clearFillBoundary(pmId: string): void {
  const db = getDb();
  db.prepare(`DELETE FROM position_state WHERE pm_id = ?`).run(pmId);
}
