/**
 * Shadow-mode report (D3): turns write-only `shadow_decisions` rows into the
 * evidence an operator needs before promoting mlAgent from shadow to live.
 *
 * Metrics:
 *   - decision agreement: how often the ml and rule outputs agree on KIND,
 *     and the Jaccard overlap of their planned bins when both planned;
 *   - hypothetical in-range time: for each decision, the fraction of
 *     subsequent `price_observations` (until the next decision for the same
 *     PM) whose implied bin falls inside the planned range — computed for
 *     both arms, so "would the ml ranges have held price better?" has data;
 *   - state / kind distributions.
 *
 * Promotion stays a MANUAL flip of STRATEGY=mlAgent — this report is the
 * data, not the gate. Operator entry point: scripts/shadow-report.ts.
 */

import type { Database } from "bun:sqlite";
import type { PoolProfile } from "../pools/types.ts";
import { binIdForHumanPrice, orientationOf } from "../domain/binMath.ts";

export interface ShadowReport {
  poolId: string;
  sinceMs: number;
  untilMs: number;
  rows: number;
  /** Rows where a rule baseline was recorded. */
  rowsWithBaseline: number;
  /** Fraction of baseline rows where ml and rule agreed on output kind. */
  kindAgreementRate: number | null;
  /** Mean Jaccard overlap of addBins across rows where BOTH arms planned. */
  meanBinJaccard: number | null;
  bothPlannedRows: number;
  /** Hypothetical in-range fraction (mean over scoreable decisions). */
  mlInRangeRate: number | null;
  ruleInRangeRate: number | null;
  scoredDecisions: number;
  byState: Record<string, number>;
  byMlKind: Record<string, number>;
}

interface ShadowRow {
  id: number;
  pm_id: string;
  ts_ms: number;
  market_state: string;
  strategy_output_kind: string;
  strategy_output_json: string;
  rule_output_kind: string | null;
  rule_output_json: string | null;
}

interface PriceRow {
  price: string;
  observed_ms: number;
}

/** Extract the planned bin range from a serialized StrategyOutput. */
function plannedRange(json: string | null): { lo: number; hi: number } | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as { plan?: { addBins?: number[] } };
    const bins = parsed.plan?.addBins;
    if (!bins || bins.length === 0) return null;
    return { lo: Math.min(...bins), hi: Math.max(...bins) };
  } catch {
    return null;
  }
}

function plannedBins(json: string | null): number[] | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as { plan?: { addBins?: number[] } };
    return parsed.plan?.addBins ?? null;
  } catch {
    return null;
  }
}

function jaccard(a: number[], b: number[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 1 : inter / union;
}

export function computeShadowReport(
  db: Database,
  opts: { poolId: string; profile: PoolProfile; sinceMs: number; untilMs?: number },
): ShadowReport {
  const untilMs = opts.untilMs ?? Date.now();
  const orientation = orientationOf(opts.profile);

  const rows = db
    .prepare<ShadowRow, [string, number, number]>(
      `SELECT id, pm_id, ts_ms, market_state, strategy_output_kind,
              strategy_output_json, rule_output_kind, rule_output_json
       FROM shadow_decisions
       WHERE pool_id = ? AND ts_ms >= ? AND ts_ms < ?
       ORDER BY pm_id ASC, ts_ms ASC`,
    )
    .all(opts.poolId, opts.sinceMs, untilMs);

  const byState: Record<string, number> = {};
  const byMlKind: Record<string, number> = {};
  let rowsWithBaseline = 0;
  let kindAgreements = 0;
  let bothPlannedRows = 0;
  let jaccardSum = 0;
  let scoredDecisions = 0;
  let mlInRangeSum = 0;
  let ruleInRangeSum = 0;

  const priceStmt = db.prepare<PriceRow, [string, number, number]>(
    `SELECT price, observed_ms FROM price_observations
     WHERE pool_id = ? AND observed_ms >= ? AND observed_ms < ?
     ORDER BY observed_ms ASC`,
  );

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    byState[row.market_state] = (byState[row.market_state] ?? 0) + 1;
    byMlKind[row.strategy_output_kind] = (byMlKind[row.strategy_output_kind] ?? 0) + 1;

    if (row.rule_output_kind !== null) {
      rowsWithBaseline++;
      if (row.rule_output_kind === row.strategy_output_kind) kindAgreements++;
    }

    const mlBins = plannedBins(row.strategy_output_json);
    const ruleBins = plannedBins(row.rule_output_json);
    if (mlBins && ruleBins) {
      bothPlannedRows++;
      jaccardSum += jaccard(mlBins, ruleBins);
    }

    // Hypothetical in-range: score the window until the next decision for the
    // SAME pm (rows are ordered pm, ts).
    const next = rows[i + 1];
    const windowEnd = next && next.pm_id === row.pm_id ? next.ts_ms : untilMs;
    const mlRange = plannedRange(row.strategy_output_json);
    const ruleRange = plannedRange(row.rule_output_json);
    if (!mlRange && !ruleRange) continue;

    const prices = priceStmt.all(opts.poolId, row.ts_ms, windowEnd);
    if (prices.length === 0) continue;

    let mlIn = 0;
    let ruleIn = 0;
    for (const p of prices) {
      const priceNum = Number(p.price);
      if (!Number.isFinite(priceNum) || priceNum <= 0) continue;
      const bin = binIdForHumanPrice(orientation, priceNum);
      if (mlRange && bin >= mlRange.lo && bin <= mlRange.hi) mlIn++;
      if (ruleRange && bin >= ruleRange.lo && bin <= ruleRange.hi) ruleIn++;
    }
    scoredDecisions++;
    if (mlRange) mlInRangeSum += mlIn / prices.length;
    if (ruleRange) ruleInRangeSum += ruleIn / prices.length;
  }

  return {
    poolId: opts.poolId,
    sinceMs: opts.sinceMs,
    untilMs,
    rows: rows.length,
    rowsWithBaseline,
    kindAgreementRate: rowsWithBaseline > 0 ? kindAgreements / rowsWithBaseline : null,
    meanBinJaccard: bothPlannedRows > 0 ? jaccardSum / bothPlannedRows : null,
    bothPlannedRows,
    mlInRangeRate: scoredDecisions > 0 ? mlInRangeSum / scoredDecisions : null,
    ruleInRangeRate: scoredDecisions > 0 ? ruleInRangeSum / scoredDecisions : null,
    scoredDecisions,
    byState,
    byMlKind,
  };
}
