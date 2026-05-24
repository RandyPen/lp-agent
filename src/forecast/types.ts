/**
 * Forecaster output types. The forecaster predicts the distribution of price
 * at a horizon; downstream `binWeights` integrates that distribution across
 * each bin's [P_lower, P_upper] boundary to produce a per-bin weight.
 *
 * v0 target: log-normal with EWMA σ. Future v1 swaps in quantile regression +
 * conformal calibration without changing this shape.
 */

export interface PriceDistribution {
  /** Log-mean: log(P_center). The reference price the distribution is anchored on. */
  logMu: number;
  /**
   * Standard deviation of log-return at the horizon. Pre-scaled — if the
   * caller wants a different horizon they should re-square-root-scale.
   */
  sigma: number;
  /** Horizon in milliseconds the σ applies to. */
  horizonMs: number;
  /** Free-form provenance: 'ewma', 'parkinson', 'garch11', etc. */
  estimator: string;
}

export interface BinWeight {
  binId: number;
  /** Normalized weight in [0, 1]. Across emitted bins these sum to 1 (up to ε). */
  weight: number;
  /** Mid-price string (for diagnostics / journal). */
  priceMid: string;
}

/** OHLC bar used by the Parkinson / Garman-Klass estimators. */
export interface OhlcvBar {
  bucketStartMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
}
