/**
 * Volatility estimators (closed-form, no learning).
 *
 * Three families ship in the template, all O(n) single-pass:
 *   - `ewmaSigma`         RiskMetrics EWMA on close-to-close log returns (λ=0.94)
 *   - `parkinsonSigma`    high/low range, ~5× more efficient than C2C
 *   - `garmanKlassSigma`  OHLC, ~7× more efficient than C2C
 *
 * These are *estimators*, not models — no parameters are learned, no training
 * data is needed, no checkpoints exist. The constants λ=0.94, 1/(4 ln 2),
 * (2 ln 2 − 1) come from RiskMetrics / Brownian-motion math, not from fitting.
 *
 * For a learned σ (GARCH(1,1) MLE, LightGBM quantile, LSTM, …) see
 * `docs/forecasting-approach.md` §"Upgrading to a learned model" — drop a new
 * file `src/forecast/ml.ts` and have your Strategy call it instead.
 *
 * All inputs are plain JS numbers (decimal-adjusted prices, oldest-first).
 * Outputs are σ values in log-return units, per *one bar period*. Callers
 * scale to their horizon via σ × √(N) where N = horizon / bar-period.
 */

import type { OhlcvBar } from "./types.ts";

/** RiskMetrics-style EWMA decay. λ = 0.94 ≈ 75-period half-life. */
export const DEFAULT_EWMA_LAMBDA = 0.94;

/** Floor σ so tiny price histories don't produce zero variance (would NaN the integral). */
export const MIN_SIGMA = 1e-6;

/**
 * Close-to-close EWMA σ. `prices` is oldest-first; returns σ in log-return
 * units per bar period (same period as the spacing between consecutive prices).
 */
export function ewmaSigma(prices: number[], lambda = DEFAULT_EWMA_LAMBDA): number {
  if (prices.length < 2) return MIN_SIGMA;
  if (lambda <= 0 || lambda >= 1) {
    throw new Error(`ewmaSigma: lambda must be in (0, 1), got ${lambda}`);
  }

  // Initialise σ² from the first squared return so the early window isn't biased toward 0.
  let prev = prices[0]!;
  const r0 = Math.log(prices[1]! / prev);
  let varEst = r0 * r0;
  prev = prices[1]!;

  for (let i = 2; i < prices.length; i++) {
    const p = prices[i]!;
    const r = Math.log(p / prev);
    varEst = lambda * varEst + (1 - lambda) * r * r;
    prev = p;
  }

  return Math.max(Math.sqrt(varEst), MIN_SIGMA);
}

/**
 * Parkinson volatility estimator, σ_P = √(ln²(H/L) / (4·ln(2))) per bar,
 * averaged across bars. ~5× more efficient than close-to-close when intraday
 * range is informative.
 */
export function parkinsonSigma(bars: OhlcvBar[]): number {
  if (bars.length === 0) return MIN_SIGMA;
  const factor = 1 / (4 * Math.log(2));
  let sum = 0;
  let n = 0;
  for (const bar of bars) {
    if (bar.high <= 0 || bar.low <= 0 || bar.high === bar.low) continue;
    const ln = Math.log(bar.high / bar.low);
    sum += factor * ln * ln;
    n++;
  }
  if (n === 0) return MIN_SIGMA;
  return Math.max(Math.sqrt(sum / n), MIN_SIGMA);
}

/**
 * Garman-Klass volatility: σ² = 0.5·ln²(H/L) - (2·ln(2)-1)·ln²(C/O), averaged.
 * ~7× more efficient than close-to-close.
 */
export function garmanKlassSigma(bars: OhlcvBar[]): number {
  if (bars.length === 0) return MIN_SIGMA;
  const coef = 2 * Math.log(2) - 1;
  let sum = 0;
  let n = 0;
  for (const bar of bars) {
    if (bar.high <= 0 || bar.low <= 0 || bar.open <= 0 || bar.close <= 0) continue;
    const lnHL = Math.log(bar.high / bar.low);
    const lnCO = Math.log(bar.close / bar.open);
    const v = 0.5 * lnHL * lnHL - coef * lnCO * lnCO;
    if (v > 0) {
      sum += v;
      n++;
    }
  }
  if (n === 0) return MIN_SIGMA;
  return Math.max(Math.sqrt(sum / n), MIN_SIGMA);
}

/**
 * Scale a per-bar σ to a target horizon via square-root-of-time.
 *
 * The bar period is the spacing between observations the estimator consumed
 * (e.g. 60_000 ms for 1-minute bars). For sqrt-of-time scaling to hold, the
 * underlying process needs to be roughly IID across the horizon — fine for
 * short horizons (≤ 24h) but breaks down for longer ones where regime
 * switching dominates.
 */
export function scaleSigmaToHorizon(
  sigmaPerBar: number,
  barPeriodMs: number,
  horizonMs: number,
): number {
  if (barPeriodMs <= 0) throw new Error("scaleSigmaToHorizon: barPeriodMs must be > 0");
  const periods = horizonMs / barPeriodMs;
  if (periods <= 0) return MIN_SIGMA;
  return Math.max(sigmaPerBar * Math.sqrt(periods), MIN_SIGMA);
}

/**
 * Bucket a list of {timestampMs, price} observations into OHLC bars of a fixed
 * width. Buckets are aligned to epoch ms / bucketMs.
 */
export function bucketToOhlcv(
  observations: { timestampMs: number; price: number }[],
  bucketMs: number,
): OhlcvBar[] {
  if (observations.length === 0) return [];
  if (bucketMs <= 0) throw new Error("bucketToOhlcv: bucketMs must be > 0");

  // observations may arrive out of order; sort first.
  const sorted = [...observations].sort((a, b) => a.timestampMs - b.timestampMs);
  const bars: OhlcvBar[] = [];

  let current: OhlcvBar | null = null;
  for (const obs of sorted) {
    const bucket = Math.floor(obs.timestampMs / bucketMs) * bucketMs;
    if (current && current.bucketStartMs === bucket) {
      current.high = Math.max(current.high, obs.price);
      current.low = Math.min(current.low, obs.price);
      current.close = obs.price;
    } else {
      if (current) bars.push(current);
      current = {
        bucketStartMs: bucket,
        open: obs.price,
        high: obs.price,
        low: obs.price,
        close: obs.price,
      };
    }
  }
  if (current) bars.push(current);

  return bars;
}
