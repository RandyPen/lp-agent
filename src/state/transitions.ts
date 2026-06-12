/**
 * Pure transition predicates for the three-state market-making state machine.
 *
 * References:
 *   - decision-engine-design.md §2.2–§2.3 (state table, hysteresis)
 *   - implementation-plan-v1.md §5.2–§5.3 (triggers, dwell, exit)
 *
 * Design notes:
 *   - All functions are pure (no side effects, no I/O).
 *   - `now` is injected so tests are deterministic.
 *   - `extremeSignal` is injected by the risk module (L2 circuit breaker).
 *     The local p-sum check runs independently; either source can trigger EXTREME.
 *   - Min-dwell enforcement: no transition is allowed until `nowMs >=
 *     enteredAtMs + minDwellMs` regardless of any other condition.
 *
 * ---------------------------------------------------------------------------
 * drift_strength formula
 * ---------------------------------------------------------------------------
 *
 * `drift_strength` measures the sustained directional momentum of the active
 * bin relative to historical spread.  It is computed from the two most recent
 * 1-minute close prices in `snapshot.binance.sui`:
 *
 *   let r_t   = (close[n-1] − close[n-2]) / close[n-2]   // last 1-min return
 *   let r_t1  = (close[n-2] − close[n-3]) / close[n-3]   // second-to-last return
 *   let σ_ewm = EWMA of |returns| over the "background" window (bars 0..n-3,
 *               i.e. excluding the two signal bars), λ = 0.94, σ floor = 1e-6.
 *               The two signal bars are excluded from the denominator so that
 *               a sudden burst of large moves elevates the ratio rather than
 *               cancelling itself out.
 *   drift_strength = (|r_t| + |r_t1|) / (2 × σ_ewm)
 *
 * Rationale: this is a local signal-to-noise ratio — how large are the two
 * most recent 1-min moves relative to the background volatility?  A value > 2
 * means consecutive bars each moved more than 2× the typical background move.
 * The "2 consecutive 1-min window" requirement in the design is satisfied by
 * using two bars (r_t and r_t1) rather than a single bar return.
 *
 * When fewer than 4 bars are available (need ≥ 1 background bar), drift_strength
 * = 0 (cannot be TREND from price alone; may still enter via p-break).
 */

import type { MarketSnapshot, MarketState, PredictionResponse } from "../prediction/types.ts";
import {
  DRIFT_STRENGTH_ENTRY,
  DRIFT_STRENGTH_EXIT,
  MIN_DWELL_MS,
  P_BREAK_ENTRY,
  P_BREAK_SUM_EXTREME,
} from "./params.ts";

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

/**
 * External signal from the risk module (L2 circuit breaker).
 * When `active` is true the state machine immediately enters EXTREME if dwell
 * allows.  The `trigger` string is stored verbatim in `market_state_history`.
 */
export interface ExtremeSignal {
  active: boolean;
  trigger: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Compute `drift_strength` from the price bars in the market snapshot.
 *
 * Formula (see module-level doc comment):
 *   drift_strength = (|r_t| + |r_t1|) / (2 × σ_ewm)
 *
 * where:
 *   r_t   = (close[n-1] − close[n-2]) / close[n-2]   — last 1-min return
 *   r_t1  = (close[n-2] − close[n-3]) / close[n-3]   — second-to-last return
 *   σ_ewm = EWMA of |returns| computed over bars 0..n-3 (the "background"
 *           window, λ=0.94, σ floor=1e-6).  The two signal bars (n-1, n-2)
 *           are EXCLUDED from the background so that a sudden burst of moves
 *           elevates the ratio instead of cancelling itself out in the
 *           denominator.
 *
 * Returns 0 when there are fewer than 4 bars (need ≥ 1 background bar plus
 * 3 close prices for two returns).
 */
export function computeDriftStrength(snapshot: MarketSnapshot): number {
  const bars = snapshot.binance.sui;
  // Need at least 4 bars: bars[0..n-4] form the background window;
  // bars[n-3], bars[n-2], bars[n-1] supply the two signal returns.
  if (bars.length < 4) return 0;

  const closes: number[] = bars.map((b) => b.close);
  const n = closes.length;

  // Signal returns: the two most recent 1-min close-to-close changes
  const close0 = closes[n - 1]!;
  const close1 = closes[n - 2]!;
  const close2 = closes[n - 3]!;

  if (close1 <= 0 || close2 <= 0) return 0;

  const rT  = (close0 - close1) / close1;
  const rT1 = (close1 - close2) / close2;

  // Background EWMA of |returns| over bars[0..n-3], i.e. excluding the two
  // signal bars.  Window size limited to 30 bars before the signal window.
  const LAMBDA = 0.94;
  const FLOOR = 1e-6;
  // Background range: indices 1..n-3 (returns from close[0]→close[1] .. close[n-4]→close[n-3])
  const bgEnd = n - 3;     // last background bar index (inclusive)
  const bgStart = Math.max(1, bgEnd - 29);  // up to 30 bars back
  let ewma = 0;
  let initialised = false;
  for (let i = bgStart; i <= bgEnd; i++) {
    const prevClose = closes[i - 1];
    const currClose = closes[i];
    if (prevClose === undefined || currClose === undefined || prevClose <= 0) continue;
    const absRet = Math.abs((currClose - prevClose) / prevClose);
    if (!initialised) {
      ewma = absRet;
      initialised = true;
    } else {
      ewma = LAMBDA * ewma + (1 - LAMBDA) * absRet;
    }
  }

  const sigmaEwm = Math.max(FLOOR, ewma);
  return (Math.abs(rT) + Math.abs(rT1)) / (2 * sigmaEwm);
}

// ---------------------------------------------------------------------------
// Min-dwell guard
// ---------------------------------------------------------------------------

/**
 * Returns true when the minimum dwell time for `currentState` has elapsed
 * since `enteredAtMs`.
 */
export function dwellElapsed(
  currentState: MarketState,
  enteredAtMs: number,
  nowMs: number,
): boolean {
  return nowMs - enteredAtMs >= MIN_DWELL_MS[currentState];
}

// ---------------------------------------------------------------------------
// Transition predicates
// ---------------------------------------------------------------------------

/**
 * NORMAL → TREND predicate.
 *
 * Triggered when EITHER:
 *   (a) drift_strength > DRIFT_STRENGTH_ENTRY (2.0) "sustained 2 consecutive
 *       1-min windows" — represented by both r_t and r_t1 in drift_strength, or
 *   (b) max(pAbove, pBelow) > P_BREAK_ENTRY (0.6)
 */
export function shouldEnterTrend(
  snapshot: MarketSnapshot,
  pred: PredictionResponse,
): boolean {
  const driftStrength = computeDriftStrength(snapshot);
  if (driftStrength > DRIFT_STRENGTH_ENTRY) return true;
  if (Math.max(pred.pAbove, pred.pBelow) > P_BREAK_ENTRY) return true;
  return false;
}

/**
 * TREND → NORMAL predicate.
 *
 * Return to NORMAL when BOTH:
 *   (a) drift_strength has fallen below the hysteresis exit threshold (1.5), AND
 *   (b) max(pAbove, pBelow) ≤ P_BREAK_ENTRY (no longer p-break dominant)
 */
export function shouldExitTrend(
  snapshot: MarketSnapshot,
  pred: PredictionResponse,
): boolean {
  const driftStrength = computeDriftStrength(snapshot);
  if (driftStrength > DRIFT_STRENGTH_EXIT) return false;
  if (Math.max(pred.pAbove, pred.pBelow) > P_BREAK_ENTRY) return false;
  return true;
}

/**
 * → EXTREME predicate (from either NORMAL or TREND).
 *
 * Triggered by EITHER:
 *   (a) An injected `extremeSignal` with `active === true` from the L2 risk
 *       module (price 5min vol > 10%, TVL drop > 50%, spread > 5% × 30s,
 *       24h PnL < −5%, data blackout — these thresholds live in src/risk/).
 *   (b) Locally: pAbove + pBelow > P_BREAK_SUM_EXTREME (0.7) — the model sees
 *       high probability of crossing the active bin on both sides simultaneously,
 *       indicating extreme uncertainty about direction.
 *
 * The `trigger` return value is a human-readable string for the DB row.
 */
export function shouldEnterExtreme(
  pred: PredictionResponse,
  extremeSignal: ExtremeSignal | null | undefined,
): { enter: boolean; trigger: string } {
  // L2 risk module injection takes priority
  if (extremeSignal?.active) {
    return { enter: true, trigger: extremeSignal.trigger };
  }

  // Local model signal: pAbove + pBelow exceeds threshold
  const pSum = pred.pAbove + pred.pBelow;
  if (pSum > P_BREAK_SUM_EXTREME) {
    return {
      enter: true,
      trigger: `p_break_sum=${pSum.toFixed(4)}>threshold=${P_BREAK_SUM_EXTREME}`,
    };
  }

  return { enter: false, trigger: "" };
}

/**
 * EXTREME → previous state clearance predicate.
 *
 * Returns true when ALL of the following hold:
 *   (a) The external risk signal is inactive (or absent) — all L2 conditions
 *       cleared by the risk module.
 *   (b) The local p-sum has dropped back below P_BREAK_SUM_EXTREME.
 *   (c) The stability window has been met: `nowMs - extremeEnteredAtMs >= 10min`.
 *   (d) Volatility recovery: the snapshot must pass the hysteresis check, which
 *       the caller indicates via `volRecovered` (the risk module compares the
 *       current rolling vol to the pre-EXTREME baseline and returns true when
 *       it has receded to within 7% of that baseline).
 *
 * Note: the 10-minute stability check is enforced here on top of the standard
 * min-dwell check in the machine — EXTREME has a 10-min minDwellMs so the
 * dwellElapsed guard will already block early exits.  The check here is
 * redundant but explicit for clarity.
 */
export function shouldExitExtreme(
  pred: PredictionResponse,
  extremeSignal: ExtremeSignal | null | undefined,
  volRecovered: boolean,
  extremeEnteredAtMs: number,
  nowMs: number,
): boolean {
  // Risk signal must be fully clear
  if (extremeSignal?.active) return false;

  // p-sum must have receded
  if (pred.pAbove + pred.pBelow > P_BREAK_SUM_EXTREME) return false;

  // Must have stabilised for the 10-min EXTREME min-dwell window
  const EXTREME_STABILITY_MS = 10 * 60 * 1_000;
  if (nowMs - extremeEnteredAtMs < EXTREME_STABILITY_MS) return false;

  // Volatility recovery hysteresis
  if (!volRecovered) return false;

  return true;
}
