/**
 * Regime-transition journal for RULE-BASED strategies that emit a StateContext
 * (currently presenceAnchor).
 *
 * mlAgent's three-state machine (src/state/machine.ts) owns its own
 * market_state_history writes; rule strategies have no machine — they nowcast
 * the regime per tick from price history and stay stateless. This helper gives
 * the operator the same auditable timeline in the SAME table:
 *
 *   DEFENSE entry row  = the "withdrawn / sold-out" record
 *   NORMAL/TREND row   = the "liquidity redeployed" record
 *
 * The caller (rebalancer) invokes it once per non-quiet tick when the live
 * strategy is NOT mlAgent (avoiding double-writes for pools driven by the
 * real state machine). The function is idempotent per state: same state as
 * the latest open row → no-op.
 *
 * Restart semantics: the strategy recomputes its regime from price history,
 * so after a restart the first tick simply re-asserts the current state; if
 * it matches the open row nothing is written — the timeline stays continuous.
 */

import type { Database } from "bun:sqlite";
import type { MarketState } from "../prediction/types.ts";
import { log } from "../lib/logger.ts";

interface OpenRow {
  id: number;
  state: string;
}

/**
 * Record a regime transition for `poolId` if `state` differs from the latest
 * open market_state_history row. Closes the previous open row and inserts the
 * new one (same persistence contract as the state machine).
 *
 * `trigger` should be prefixed by the caller with its origin (the rebalancer
 * passes "presence: <plan reason / quiet reason>").
 */
export function recordRegimeTransition(
  db: Database,
  poolId: string,
  state: MarketState,
  trigger: string,
  nowMs: number = Date.now(),
): void {
  const open = db
    .prepare<OpenRow, [string]>(
      `SELECT id, state FROM market_state_history
       WHERE pool_id = ? AND exited_at_ms IS NULL
       ORDER BY entered_at_ms DESC LIMIT 1`,
    )
    .get(poolId);

  if (open && open.state === state) return; // no transition

  if (open) {
    db.prepare(`UPDATE market_state_history SET exited_at_ms = ? WHERE id = ?`).run(nowMs, open.id);
  }
  db.prepare(
    `INSERT INTO market_state_history (pool_id, entered_at_ms, state, trigger, prev_state)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(poolId, nowMs, state, trigger, open?.state ?? null);

  log.info("regimeJournal: transition recorded", {
    pool_id: poolId,
    from: open?.state ?? null,
    to: state,
    trigger,
  });
}
