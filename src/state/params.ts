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
// Named constants (W5 grid-search will update these)
// ---------------------------------------------------------------------------

/** Multiplier applied to widthSigma to get halfWidth. k_w = 2.0 initial. */
export const K_W = 2.0;

/**
 * Uncertainty high threshold: when featureCompleteness falls below this,
 * the prediction is considered high-uncertainty and maxCenterOffset tightens
 * to 1 bin.  Initial value is P75 of the walk-forward completeness series;
 * hardcoded as 0.8 for v1 until W5 calibration.
 */
export const U_HIGH = 0.8;

/** Minimum allowed halfWidth in bins. */
export const HALF_WIDTH_MIN = 2;

/** Maximum allowed halfWidth in bins. */
export const HALF_WIDTH_MAX = 8;

/** Minimum maxCenterOffset in bins (non-high-uncertainty path). */
export const MAX_CENTER_OFFSET_MIN = 1;

/** Maximum maxCenterOffset in bins. */
export const MAX_CENTER_OFFSET_MAX = 3;

/** Denominator used to normalise (pAbove - pBelow) into trendBias. */
export const TREND_BIAS_NORMALISER = 0.5;

/** TREND entry: drift_strength threshold. */
export const DRIFT_STRENGTH_ENTRY = 2.0;

/** TREND exit: drift_strength hysteresis threshold (below this → can exit). */
export const DRIFT_STRENGTH_EXIT = 1.5;

/** TREND / NORMAL entry: p_break threshold (max(pAbove, pBelow) > this). */
export const P_BREAK_ENTRY = 0.6;

/**
 * EXTREME entry via local prediction: pAbove + pBelow > this triggers EXTREME
 * regardless of external risk signal.
 */
export const P_BREAK_SUM_EXTREME = 0.7;

/**
 * EXTREME exit: volatility recovery hysteresis.  The rolling volatility must
 * have receded to within (1 + EXTREME_VOL_HYSTERESIS) of its pre-extreme
 * baseline before the exit clearance is considered valid.  Value 0.07 = 7%.
 */
export const EXTREME_VOL_HYSTERESIS = 0.07;

/** trendBias magnitude above which strong-trend mode activates. */
export const TREND_BIAS_STRONG = 0.7;

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
 * Derive the target half-width (in bins) from model width uncertainty.
 *
 *   halfWidth = clamp(round(k_w × widthSigma), HALF_WIDTH_MIN, HALF_WIDTH_MAX)
 *
 * k_w = 2.0 (W5 grid-search calibrated).
 */
export function deriveHalfWidth(widthSigma: number): number {
  const raw = Math.round(K_W * widthSigma);
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
  const raw = Math.max(1, Math.round(widthSigma));
  return Math.min(raw, halfWidth);
}

/**
 * Derive the maximum allowed center offset (in bins from active bin).
 *
 *   When uncertainty is high (featureCompleteness > U_HIGH threshold):
 *     maxCenterOffset = 1   (center is forced back to active bin)
 *   Otherwise:
 *     maxCenterOffset = clamp(round(widthSigma), 1, 3)
 *
 * "Uncertainty high" here means featureCompleteness is below U_HIGH, making
 * the model less reliable — so we shrink the offset rather than follow the
 * predicted center.
 */
export function deriveMaxCenterOffset(
  widthSigma: number,
  uncertaintyHigh: boolean,
): number {
  if (uncertaintyHigh) return 1;
  const raw = Math.round(widthSigma);
  return Math.max(MAX_CENTER_OFFSET_MIN, Math.min(MAX_CENTER_OFFSET_MAX, raw));
}

/**
 * Derive the directional trend bias from prediction probabilities.
 *
 *   trendBias = clamp((pAbove − pBelow) / TREND_BIAS_NORMALISER, -1, 1)
 *
 * Positive → bullish (price expected to move up); negative → bearish.
 * Used only in TREND state.
 */
export function deriveTrendBias(pAbove: number, pBelow: number): number {
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
