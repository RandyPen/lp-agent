/**
 * Three-state machine parameter table and continuous-parameter derivation
 * functions.
 *
 * Design: implementation-plan-v1.md §5 and decision-engine-design.md §2–§9.
 *
 * v1 initial values are listed here as named constants. W5 grid-search will
 * freeze updated values back into this file.  All derivation functions are
 * pure — no side effects, no I/O, deterministic.
 */

import type { MarketState } from "../prediction/types.ts";

// ---------------------------------------------------------------------------
// Tunable threshold bundle (env-overridable via cfg.stateParams)
// ---------------------------------------------------------------------------

/**
 * All grid-search-calibratable state-machine thresholds, bundled so they can
 * be overridden per-deployment via env vars (`STATE_*`, see src/config.ts)
 * instead of requiring a code edit + redeploy for every W5 recalibration.
 *
 * Every derivation / transition function accepts an optional `params` argument
 * defaulting to `DEFAULT_STATE_PARAMS`, which carries the original v1 values.
 */
export interface StateParams {
  /** Multiplier applied to widthSigma to get halfWidth. */
  kW: number;
  /**
   * Uncertainty high threshold: when featureCompleteness falls below this,
   * the prediction is considered high-uncertainty and maxCenterOffset tightens
   * to 1 bin. Initial value is P75 of the walk-forward completeness series.
   */
  uHigh: number;
  /** TREND entry: drift_strength threshold. */
  driftStrengthEntry: number;
  /** TREND exit: drift_strength hysteresis threshold (below this → can exit). */
  driftStrengthExit: number;
  /** TREND / NORMAL entry: p_break threshold (max(pAbove, pBelow) > this). */
  pBreakEntry: number;
  /**
   * TREND exit hysteresis: max(pAbove, pBelow) must recede below this
   * (strictly lower than `pBreakEntry`) before the p-break condition allows
   * an exit back to NORMAL. Without a dedicated exit threshold, p-break
   * oscillating around `pBreakEntry` (e.g. 0.58 ↔ 0.62) flaps the state
   * machine every eval tick — the drift channel already has 2.0/1.5
   * hysteresis and EXTREME has its own exit band; this closes the same gap
   * for the p-break channel.
   */
  pBreakExit: number;
  /**
   * EXTREME entry via local prediction: pAbove + pBelow > this triggers
   * EXTREME regardless of external risk signal.
   */
  pBreakSumExtreme: number;
  /**
   * EXTREME exit hysteresis: p-sum must recede below this (strictly lower
   * than `pBreakSumExtreme`) before an exit is allowed. Prevents flapping
   * when the p-sum oscillates around the entry threshold.
   */
  pBreakSumExtremeExit: number;
  /** trendBias magnitude above which strong-trend mode activates. */
  trendBiasStrong: number;
}

/** v1 initial values (pre-W5-grid-search). */
export const DEFAULT_STATE_PARAMS: StateParams = {
  kW: 2.0,
  uHigh: 0.8,
  driftStrengthEntry: 2.0,
  driftStrengthExit: 1.5,
  pBreakEntry: 0.6,
  pBreakExit: 0.5,
  pBreakSumExtreme: 0.7,
  pBreakSumExtremeExit: 0.6,
  trendBiasStrong: 0.7,
};

// ---------------------------------------------------------------------------
// Fixed structural constants (not part of the grid search)
// ---------------------------------------------------------------------------

/** Minimum allowed halfWidth in bins. */
export const HALF_WIDTH_MIN = 2;

/** Maximum allowed halfWidth in bins. */
export const HALF_WIDTH_MAX = 8;

// MAX_CENTER_OFFSET_* and deriveMaxCenterOffset were removed 2026-07 with
// the center prediction head: the range center is always the active bin now
// (docs/decision-remove-center-prediction.md).

/** Denominator used to normalise (pAbove - pBelow) into trendBias. */
export const TREND_BIAS_NORMALISER = 0.5;

// ---------------------------------------------------------------------------
// Per-state fixed parameters
// ---------------------------------------------------------------------------

/**
 * Evaluation interval (ms) by state.
 * NORMAL = 20 min, TREND = 15 min, EXTREME = 1 min.
 */
export const EVAL_INTERVAL_MS: Record<MarketState, number> = {
  NORMAL: 20 * 60 * 1_000,   // 1 200 000 ms
  TREND:  15 * 60 * 1_000,   //   900 000 ms
  EXTREME:      60 * 1_000,  //    60 000 ms
};

/**
 * Minimum dwell time (ms) before a state transition is allowed.
 * NORMAL = 15 min, TREND = 15 min, EXTREME = 10 min.
 */
export const MIN_DWELL_MS: Record<MarketState, number> = {
  NORMAL:  15 * 60 * 1_000,  //   900 000 ms
  TREND:   15 * 60 * 1_000,  //   900 000 ms
  EXTREME: 10 * 60 * 1_000,  //   600 000 ms
};

/**
 * Lending percentage baseline by state.
 * NORMAL = 35%, EXTREME = 100%.
 * TREND is continuous from 50–70% — see deriveLendingPct().
 */
export const LENDING_PCT_BASE: Record<MarketState, number> = {
  NORMAL:  0.35,
  TREND:   0.50,   // minimum; linear ramp up to 0.70 via |trendBias|
  EXTREME: 1.00,
};

// L1_LENDING_BONUS was removed (F6): the L1 soft circuit bonus is applied
// exclusively in mlAgent via the RiskVeto.lendingPctBonusPp field.
// deriveLendingPct no longer accepts an l1Bonus parameter.

// ---------------------------------------------------------------------------
// Continuous parameter derivation functions
// ---------------------------------------------------------------------------

/**
 * Throw when a prediction-derived input is NaN/Infinity. The sidecar layer
 * already validates finiteness (sidecarProvider), so a non-finite value here
 * is an invariant violation — fail loudly instead of silently clamping NaN
 * into a plan. The throw propagates out of mlAgent.plan() into the
 * rebalancer's tickOne catch, which marks the tick failed and logs at error.
 */
function assertFinite(value: number, fn: string, arg: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`state/params: ${fn} received non-finite ${arg}: ${value}`);
  }
}

/**
 * Derive the target half-width (in bins) from model width uncertainty.
 *
 *   halfWidth = clamp(round(k_w × widthSigma), HALF_WIDTH_MIN, HALF_WIDTH_MAX)
 */
export function deriveHalfWidth(
  widthSigma: number,
  params: StateParams = DEFAULT_STATE_PARAMS,
): number {
  assertFinite(widthSigma, "deriveHalfWidth", "widthSigma");
  const raw = Math.round(params.kW * widthSigma);
  return Math.max(HALF_WIDTH_MIN, Math.min(HALF_WIDTH_MAX, raw));
}

/**
 * Derive the tolerance in bins before a recenter is triggered.
 *
 *   toleranceBins = max(1, round(widthSigma))
 *   capped at `halfWidth` (pre-W5-grid-search sanity bound — F4)
 *
 * A wider predicted distribution tolerates more drift before recentering.
 *
 * The cap at `halfWidth` prevents a pathological case at real SUI volatility
 * where widthSigma exceeds HALF_WIDTH_MAX (8): without the cap, toleranceBins
 * can exceed halfWidth, making the tolerance guard permanently true (the
 * position center can never drift farther than halfWidth bins from the target).
 * The cap ensures toleranceBins ≤ halfWidth so the guard remains meaningful.
 * W5 grid-search will calibrate the exact ratio; this is a pre-calibration
 * safety bound only.
 *
 * @param widthSigma - predicted distribution width in bin units
 * @param halfWidth  - derived halfWidth for this tick (from deriveHalfWidth)
 */
export function deriveToleranceBins(widthSigma: number, halfWidth: number): number {
  assertFinite(widthSigma, "deriveToleranceBins", "widthSigma");
  assertFinite(halfWidth, "deriveToleranceBins", "halfWidth");
  const raw = Math.max(1, Math.round(widthSigma));
  return Math.min(raw, halfWidth);
}

/**
 * Derive the directional trend bias from prediction probabilities.
 *
 *   trendBias = clamp((pAbove − pBelow) / TREND_BIAS_NORMALISER, -1, 1)
 *
 * Positive → bullish (price expected to move up); negative → bearish.
 * Used only in TREND state.
 *
 * NOTE (2026-07, center removal): with the prediction center pinned at 0,
 * pAbove − pBelow reflects range asymmetry around the active bin, not a
 * learned market direction — see PredictionResponse.pAbove docs.
 */
export function deriveTrendBias(pAbove: number, pBelow: number): number {
  assertFinite(pAbove, "deriveTrendBias", "pAbove");
  assertFinite(pBelow, "deriveTrendBias", "pBelow");
  const raw = (pAbove - pBelow) / TREND_BIAS_NORMALISER;
  return Math.max(-1, Math.min(1, raw));
}

/**
 * Derive the target lending fraction of PM balance.
 *
 * State baselines:
 *   NORMAL  → 35 %
 *   TREND   → linear interpolation 50–70 % based on |trendBias|:
 *               base(50%) + (70% − 50%) × |trendBias|
 *   EXTREME → 100 %
 *
 * Note: the L1 soft circuit-breaker bonus (+10 pp) is applied EXTERNALLY in
 * mlAgent via RiskVeto.lendingPctBonusPp — not here. This function always
 * returns the state-machine baseline with no L1 adjustment (F6 dead-code removal).
 */
export function deriveLendingPct(
  state: MarketState,
  trendBias: number,
): number {
  assertFinite(trendBias, "deriveLendingPct", "trendBias");
  let base: number;
  if (state === "EXTREME") {
    base = LENDING_PCT_BASE.EXTREME;  // 1.0
  } else if (state === "TREND") {
    // 50% + linear ramp of up to 20pp based on |trendBias| strength
    base = LENDING_PCT_BASE.TREND + 0.20 * Math.abs(trendBias);
  } else {
    base = LENDING_PCT_BASE.NORMAL;
  }

  return Math.max(0, Math.min(1, base));
}
