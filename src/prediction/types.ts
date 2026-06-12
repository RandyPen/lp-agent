/**
 * Prediction subsystem types (W2 — PredictionProvider interface seam).
 *
 * These types form the contract between the TS orchestration layer and any
 * prediction implementation (NullPredictionProvider, SidecarPredictionProvider,
 * or a fork's custom model). The sidecar's HTTP /predict endpoint accepts
 * MarketSnapshot and returns PredictionResponse using the same field names in
 * snake_case JSON.
 *
 * See docs/prediction-service-design.md for the full HTTP contract.
 */

// ---------------------------------------------------------------------------
// Market data
// ---------------------------------------------------------------------------

/**
 * One OHLCV bar from a price source (Binance 1-minute or coarser aggregates).
 * All prices are decimal-adjusted (human-readable, not raw atomic units).
 * `volume` is in base-asset units.
 *
 * Note: this mirrors `src/forecast/types.ts OhlcvBar` but adds `volume` and
 * drops the internal `bucketStartMs` naming in favour of the generic `ts`.
 */
export interface OhlcvBar {
  /** Bar open timestamp in epoch milliseconds. */
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Multi-source market snapshot assembled by `marketAggregator` and passed to
 * `PredictionProvider.predict`. It is also serialised as the POST /predict body
 * when using the Python sidecar.
 *
 * `binance.sui` bars are the primary feature source for v1 models.
 * `binance.btc` and `binance.eth` supply cross-asset momentum features.
 * `derivatives` fields are optional futures data (may be zeros for spot-only setups).
 * `spread` = (cetus_price − binance_price) / binance_price — used by risk monitors.
 */
export interface MarketSnapshot {
  /** Snapshot assembly timestamp (epoch ms). */
  ts: number;
  /** On-chain Cetus pool state. */
  cetus: {
    activeBin: number;
    /** Human-readable mid-price string (coinB per coinA). */
    price: string;
    tvlUsd: number;
    binStep: number;
  };
  /** Binance REST/WS data, oldest-first. */
  binance: {
    sui: OhlcvBar[];
    btc: OhlcvBar[];
    eth: OhlcvBar[];
  };
  /** Derivatives market context (funding rate, open interest, liquidation flow). */
  derivatives: {
    /** Latest funding rate (fractional, e.g. 0.0001 = 1 bp). */
    funding: number;
    /** Open interest in USD. */
    oi: number;
    /** 1-minute liquidation volume in USD. */
    liq1m: number;
  };
  /** Cross-market spread: (cetus_price − binance_price) / binance_price. */
  spread: number;
}

// ---------------------------------------------------------------------------
// Prediction output
// ---------------------------------------------------------------------------

/**
 * Output of `PredictionProvider.predict`. All center offsets are in bin units,
 * relative to the current `activeBin`.
 *
 * `fallback` semantics (see prediction-service-design.md §4.2 and §4.4):
 *   false          — normal inference, all fields reflect the model's output
 *   "psi"          — feature distribution drift detected (PSI > 0.25 × 3h)
 *   "missing"      — feature completeness below threshold (< 70%)
 *   "stale"        — snapshot timestamp too old relative to eval interval
 *   "sidecar_down" — HTTP connection to Python sidecar failed
 *   "timeout"      — HTTP request timed out (2 s default)
 *
 * When `fallback !== false` the field values are still populated (sidecar
 * returns best-effort values for shadow comparison), but `mlAgent` must
 * switch to Tier 0 and record the fallback reason.
 */
export interface PredictionResponse {
  /** q50: predicted center bin offset relative to active bin. */
  centerOffset: number;
  /** q10: lower quantile of center offset distribution. */
  centerQ10: number;
  /** q90: upper quantile of center offset distribution. */
  centerQ90: number;
  /**
   * Predicted distribution width in bin units.
   * widthSigma = (centerQ90 − centerQ10) / 2.56
   * (dividing by 2.56 converts the 80 % quantile spread to a σ-equivalent).
   *
   * Note: the sidecar's widthSigma measures center-prediction uncertainty
   * (quantile spread / 2.56), NOT raw price σ. It represents how uncertain
   * the model is about where the center will be, in bin units.
   */
  widthSigma: number;
  /**
   * Probability that the price will move above the upper boundary of the
   * current active bin range within the prediction horizon.
   *
   * Definition (aligned with sidecar ml/serving/app.py):
   *   pAbove = 1 − Φ((upperOffset − q50) / widthSigma)
   * where upperOffset is the upper boundary of the PM's current bin range
   * (in bin units relative to activeBin), defaulting to +0.5 bin when no
   * range context is provided. q50 = centerOffset (= 0 for NullProvider).
   *
   * Both pAbove and pBelow use bin-unit offsets so they are scale-invariant
   * with respect to the pool's binStep.
   */
  pAbove: number;
  /**
   * Probability that the price will move below the lower boundary of the
   * current active bin range within the prediction horizon.
   *
   * Definition (aligned with sidecar ml/serving/app.py):
   *   pBelow = Φ((lowerOffset − q50) / widthSigma)
   * where lowerOffset is the lower boundary of the PM's current bin range
   * (in bin units, typically negative), defaulting to −0.5 bin when no
   * range context is provided. q50 = centerOffset (= 0 for NullProvider).
   */
  pBelow: number;
  /** Model artifact version string (e.g. "null-v0", "v1.0.0"). */
  modelVersion: string;
  /**
   * Fraction of expected input features that were present and non-null.
   * Range [0, 1]. Values below 0.7 trigger fallback="missing".
   */
  featureCompleteness: number;
  /**
   * Population Stability Index of the latest feature window vs the training
   * baseline. PSI > 0.25 over 3 consecutive 1h windows triggers fallback="psi".
   */
  psi: number;
  /** Degradation reason, or false when the response is from normal inference. */
  fallback: false | "psi" | "missing" | "stale" | "sidecar_down" | "timeout";
}

// ---------------------------------------------------------------------------
// Three-state machine types
// ---------------------------------------------------------------------------

/**
 * The three operating states of the market-making state machine.
 * See implementation-plan-v1.md §5.2 and decision-engine-design.md.
 */
export type MarketState = "NORMAL" | "TREND" | "EXTREME";

/**
 * Continuous parameters derived from the current `MarketState` + latest
 * `PredictionResponse`. All downstream consumers (mlAgent, diffPlanner,
 * lending router) read these values rather than branching on `state` directly,
 * which keeps the state machine logic localised to `src/state/`.
 *
 * `halfWidth`, `toleranceBins`, and `lendingPct` are continuous values; they
 * replace the six discrete NARROW/WIDE sub-states from the v1.0 plan.
 */
export interface StateContext {
  state: MarketState;
  /** Epoch ms when this state was entered. */
  enteredAtMs: number;
  /** How often (ms) the rebalancer should evaluate this PM in this state. */
  evalIntervalMs: number;
  /**
   * Target half-width of the liquidity range in bins.
   * Continuous: halfWidth = clamp(round(k_w × widthSigma), 2, 8) where k_w ≈ 2.
   */
  halfWidth: number;
  /**
   * Trend bias in [-1, 1]. Non-zero only in TREND state.
   * trendBias = clamp((pAbove − pBelow) / 0.5, -1, 1).
   * Positive → bullish skew; negative → bearish skew.
   */
  trendBias: number;
  /**
   * Fraction of PM balance that should be parked in lending.
   * Range [0, 1]. In EXTREME state this is 1.0 (100% lending).
   */
  lendingPct: number;
  /**
   * Maximum allowed drift in bins from the predicted center before a
   * recenter is triggered.
   *
   * Derivation (params.ts §5.1):
   *   toleranceBins = max(1, round(widthSigma))
   *   capped at halfWidth to prevent the tolerance guard from becoming
   *   permanently true when real SUI vol causes widthSigma >> halfWidth.
   */
  toleranceBins: number;
  /**
   * Maximum allowed center offset in bins from the active bin (F5).
   *
   * Derivation (params.ts deriveMaxCenterOffset):
   *   When featureCompleteness < U_HIGH (uncertainty high):  maxCenterOffset = 1
   *   Otherwise: clamp(round(widthSigma), 1, 3)
   *
   * diffPlanner reads this directly instead of re-deriving it, ensuring the
   * state machine is the single source of truth for this parameter.
   */
  maxCenterOffset: number;
  /**
   * Minimum time (ms) to remain in the current state before a transition is
   * allowed. Prevents rapid oscillation at state boundaries.
   */
  minDwellMs: number;
}

// ---------------------------------------------------------------------------
// Provider supporting types
// ---------------------------------------------------------------------------

/**
 * Per-PM context passed to `PredictionProvider.predict`. Tells the provider
 * which bin range the PM currently covers so it can compute bin-relative
 * outputs (pAbove/pBelow against the current range boundaries).
 *
 * `currentBins` is the list of bin IDs the PM has open positions in; may be
 * empty when the PM has no open position yet.
 */
export interface PmRangeContext {
  /** PositionManager object ID on-chain. */
  pmId: string;
  /** Current active bin of the pool (not the PM's position center). */
  activeBin: number;
  /** Pool bin step in basis points (e.g. 10 for a 0.1 % step). */
  binStep: number;
  /** Bin IDs currently covered by the PM's open position. */
  currentBins: number[];
}

/**
 * Health status returned by `PredictionProvider.health()`.
 * Used by the rebalancer's monitoring loop and the shadow-mode reporter.
 */
export interface ProviderHealth {
  /** true when the provider can serve predictions without falling back. */
  ok: boolean;
  /**
   * Artifact version the provider is currently serving.
   * Undefined for providers that don't version their models (e.g. NullProvider).
   */
  modelVersion?: string;
  /** Human-readable status detail or error message. */
  detail?: string;
}
