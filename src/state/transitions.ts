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
 *   - Min-dwell enforcement: non-emergency transitions are blocked until
 *     `nowMs >= enteredAtMs + minDwellMs`. EXTREME **entry** is the exception —
 *     the machine (machine.ts) evaluates it before the dwell gate, because for
 *     a custody agent entering the protective state late is the failure mode.
 *     EXTREME **exit** still respects dwell + stability + vol recovery.
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
  DEFAULT_STATE_PARAMS,
  MIN_DWELL_MS,
  type StateParams,
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

  // Fail loudly on corrupted feed data: a NaN/Infinity close would silently
  // disable TREND entry (NaN > threshold === false) while still permitting
  // TREND exit — the worst combination. The feed layer owns data hygiene;
  // a non-finite close reaching here is an invariant violation.
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(closes[i]!)) {
      throw new RangeError(
        `state/transitions: computeDriftStrength received non-finite close at bar ${i}: ${closes[i]}`,
      );
    }
  }

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
  params: StateParams = DEFAULT_STATE_PARAMS,
): boolean {
  const driftStrength = computeDriftStrength(snapshot);
  if (driftStrength > params.driftStrengthEntry) return true;
  if (Math.max(pred.pAbove, pred.pBelow) > params.pBreakEntry) return true;
  return false;
}

/**
 * TREND → NORMAL predicate.
 *
 * Return to NORMAL when BOTH:
 *   (a) drift_strength has fallen below the hysteresis exit threshold (1.5), AND
 *   (b) max(pAbove, pBelow) has receded below P_BREAK_EXIT (0.5 by default) —
 *       a DEDICATED exit threshold strictly below P_BREAK_ENTRY (0.6), so a
 *       p-break value oscillating in the 0.5–0.6 band cannot flap the state
 *       machine TREND↔NORMAL every eval tick (mirrors the drift-strength
 *       2.0/1.5 hysteresis and the EXTREME pBreakSumExtreme/Exit band).
 */
export function shouldExitTrend(
  snapshot: MarketSnapshot,
  pred: PredictionResponse,
  params: StateParams = DEFAULT_STATE_PARAMS,
): boolean {
  const driftStrength = computeDriftStrength(snapshot);
  if (driftStrength > params.driftStrengthExit) return false;
  if (Math.max(pred.pAbove, pred.pBelow) > params.pBreakExit) return false;
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
  params: StateParams = DEFAULT_STATE_PARAMS,
): { enter: boolean; trigger: string } {
  // L2 risk module injection takes priority
  if (extremeSignal?.active) {
    return { enter: true, trigger: extremeSignal.trigger };
  }

  // Local model signal: pAbove + pBelow exceeds threshold
  const pSum = pred.pAbove + pred.pBelow;
  if (pSum > params.pBreakSumExtreme) {
    return {
      enter: true,
      trigger: `p_break_sum=${pSum.toFixed(4)}>threshold=${params.pBreakSumExtreme}`,
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
 *   (b) The local p-sum has dropped back below `pBreakSumExtremeExit` — a
 *       dedicated exit threshold strictly below the entry threshold, so a
 *       p-sum oscillating around the entry value cannot flap EXTREME on/off.
 *   (c) The stability window has been met: `nowMs - extremeEnteredAtMs >=
 *       MIN_DWELL_MS.EXTREME` (10 min).
 *   (d) Volatility recovery: the snapshot must pass the hysteresis check, which
 *       the caller indicates via `volRecovered` (the risk module compares the
 *       current rolling vol to the recovery threshold and returns true when it
 *       has receded below it).
 *
 * Note: the stability check reuses MIN_DWELL_MS.EXTREME, the same window the
 * machine's dwellElapsed guard enforces — redundant but explicit for clarity.
 */
export function shouldExitExtreme(
  pred: PredictionResponse,
  extremeSignal: ExtremeSignal | null | undefined,
  volRecovered: boolean,
  extremeEnteredAtMs: number,
  nowMs: number,
  params: StateParams = DEFAULT_STATE_PARAMS,
): boolean {
  // Risk signal must be fully clear
  if (extremeSignal?.active) return false;

  // p-sum must have receded below the EXIT threshold (hysteresis band between
  // pBreakSumExtremeExit and pBreakSumExtreme)
  if (pred.pAbove + pred.pBelow > params.pBreakSumExtremeExit) return false;

  // Must have stabilised for the EXTREME min-dwell window
  if (nowMs - extremeEnteredAtMs < MIN_DWELL_MS.EXTREME) return false;

  // Volatility recovery hysteresis
  if (!volRecovered) return false;

  return true;
}
