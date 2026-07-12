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
 * Output of `PredictionProvider.predict`.
 *
 * There is deliberately NO predicted center: the former q50/q10/q90 center
 * heads were removed 2026-07 after walk-forward showed the q50 placed the
 * center WORSE than spot and its sign was a coin flip
 * (docs/decision-remove-center-prediction.md). The served distribution is
 * center ≡ activeBin with width from the vol head.
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
  /**
   * σ of the end-of-horizon price-offset distribution, in bin units,
   * centered on the active bin.
   *
   * Sidecar: the vol head's per-bar σ scaled to the model horizon —
   *   widthSigma = σ̂_perBar × √horizon_bars / ln(1 + bin_step)
   * NullProvider: EWMA σ scaled the same way. The two providers now ship the
   * SAME quantity (before the center removal the sidecar sent the q10–q90
   * quantile spread / 2.56, a subtly different measure).
   */
  widthSigma: number;
  /**
   * Probability that the price ends above the upper boundary of the current
   * bin range at the prediction horizon.
   *
   * Definition (aligned with sidecar ml/serving/app.py):
   *   pAbove = 1 − Φ(upperOffset / widthSigma)
   * where upperOffset is the upper boundary of the PM's current bin range
   * (in bin units relative to activeBin), defaulting to +0.5 bin when no
   * range context is provided. The center is pinned at 0 (spot).
   *
   * Both pAbove and pBelow use bin-unit offsets so they are scale-invariant
   * with respect to the pool's binStep.
   */
  pAbove: number;
  /**
   * Probability that the price ends below the lower boundary of the current
   * bin range at the prediction horizon.
   *
   * Definition (aligned with sidecar ml/serving/app.py):
   *   pBelow = Φ(lowerOffset / widthSigma)
   * where lowerOffset is the lower boundary of the PM's current bin range
   * (in bin units, typically negative), defaulting to −0.5 bin when no
   * range context is provided. The center is pinned at 0 (spot).
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
   *
   * NOTE (2026-07, center removal): with the prediction center pinned at 0,
   * pAbove − pBelow is non-zero only when the position range sits
   * asymmetrically around the active bin — i.e. this now measures "which
   * side of our range is price closer to breaking", not a learned market
   * direction (the old q50-derived tilt was statistically a coin flip).
   */
  trendBias: number;
  /**
   * Whether |trendBias| exceeds the strong-trend threshold
   * (`stateParams.trendBiasStrong`, default 0.7). Derived by the state machine
   * so diffPlanner and downstream consumers share a single source of truth for
   * the weak-trend/strong-trend regime switch.
   */
  strongTrend: boolean;
  /**
   * Fraction of PM balance that should be parked in lending.
   * Range [0, 1]. In EXTREME state this is 1.0 (100% lending).
   */
  lendingPct: number;
  /**
   * Maximum allowed drift in bins from the range center (the active bin at
   * placement time) before a recenter is triggered.
   *
   * Derivation (params.ts §5.1):
   *   toleranceBins = max(1, round(widthSigma))
   *   capped at halfWidth to prevent the tolerance guard from becoming
   *   permanently true when real SUI vol causes widthSigma >> halfWidth.
   */
  toleranceBins: number;
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
