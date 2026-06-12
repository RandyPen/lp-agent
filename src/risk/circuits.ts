/**
 * src/risk/circuits.ts
 *
 * Pure trigger-evaluation functions for L2 (EXTREME) circuit-breaker conditions.
 * Each function operates over a window of historical data points and returns a
 * structured result describing whether the condition fires and by how much.
 *
 * Design goals:
 * - Pure: no I/O, no side effects. Easy to unit-test.
 * - Deterministic: inject `nowMs` where timing matters.
 * - Each L2 condition is a separate function for isolated testability.
 *
 * See docs/risk-monitoring-design.md §四 and implementation-plan-v1.md §5.3.
 */

// ---------------------------------------------------------------------------
// Window entry types
// ---------------------------------------------------------------------------

export interface PricePoint {
  ts: number;   // epoch ms
  price: number;
}

export interface TvlPoint {
  ts: number;   // epoch ms
  tvlUsd: number;
}

export interface SpreadPoint {
  ts: number;     // epoch ms
  spread: number; // abs((cetus - binance) / binance)
}

// ---------------------------------------------------------------------------
// Trigger result
// ---------------------------------------------------------------------------

export interface TriggerResult {
  /** Whether the L2 condition currently fires. */
  fires: boolean;
  /** Human-readable metric name for the risk_events table. */
  metric: string;
  /** The configured threshold. */
  threshold: number;
  /** The measured/observed value (NaN if insufficient data). */
  observed: number;
}

// ---------------------------------------------------------------------------
// Window utility
// ---------------------------------------------------------------------------

/** Return all points in `window` whose `ts` is within `durationMs` before `nowMs`. */
export function withinWindow<T extends { ts: number }>(
  window: T[],
  nowMs: number,
  durationMs: number,
): T[] {
  const cutoff = nowMs - durationMs;
  return window.filter((p) => p.ts >= cutoff);
}

// ---------------------------------------------------------------------------
// L2 trigger: 5-minute price volatility
// ---------------------------------------------------------------------------

/**
 * Fires when |maxPrice - minPrice| / minPrice over the last 5 minutes exceeds
 * the threshold. Returns NaN as observed when fewer than 2 data points exist.
 */
export function checkVolatility5m(
  priceWindow: PricePoint[],
  threshold: number,
  nowMs: number,
  windowMs = 5 * 60 * 1000,
): TriggerResult {
  const recent = withinWindow(priceWindow, nowMs, windowMs);
  if (recent.length < 2) {
    return { fires: false, metric: "volatility_5m", threshold, observed: NaN };
  }
  const prices = recent.map((p) => p.price);
  const maxP = Math.max(...prices);
  const minP = Math.min(...prices);
  // Guard against zero/negative prices
  const observed = minP > 0 ? (maxP - minP) / minP : NaN;
  return {
    fires: Number.isFinite(observed) && observed > threshold,
    metric: "volatility_5m",
    threshold,
    observed,
  };
}

// ---------------------------------------------------------------------------
// L2 trigger: 5-minute TVL drop
// ---------------------------------------------------------------------------

/**
 * Fires when (oldest_tvl - newest_tvl) / oldest_tvl over the last 5 minutes
 * exceeds the threshold. "Oldest" here is the first entry in the 5-min window.
 */
export function checkTvlDrop5m(
  tvlWindow: TvlPoint[],
  threshold: number,
  nowMs: number,
  windowMs = 5 * 60 * 1000,
): TriggerResult {
  const recent = withinWindow(tvlWindow, nowMs, windowMs);
  if (recent.length < 2) {
    return { fires: false, metric: "tvl_drop_5m", threshold, observed: NaN };
  }
  const sorted = [...recent].sort((a, b) => a.ts - b.ts);
  const oldest = sorted[0]!.tvlUsd;
  const newest = sorted[sorted.length - 1]!.tvlUsd;
  if (oldest <= 0) {
    return { fires: false, metric: "tvl_drop_5m", threshold, observed: NaN };
  }
  const observed = (oldest - newest) / oldest;
  return {
    fires: observed > threshold,
    metric: "tvl_drop_5m",
    threshold,
    observed,
  };
}

// ---------------------------------------------------------------------------
// L2 trigger: sustained cross-market spread
// ---------------------------------------------------------------------------

/**
 * Fires when |spread| has continuously stayed above `spreadThreshold` for at
 * least `sustainMs` milliseconds ending at `nowMs`.
 *
 * "Continuously" means every entry in the window over that period exceeds the
 * threshold AND the first entry is old enough (i.e., the spread has been high
 * since at least nowMs - sustainMs).
 */
export function checkSpreadSustained(
  spreadWindow: SpreadPoint[],
  spreadThreshold: number,
  sustainMs: number,
  nowMs: number,
): TriggerResult {
  // We need points spanning at least sustainMs. Look at all points.
  const relevant = spreadWindow.filter((p) => p.ts <= nowMs);
  if (relevant.length === 0) {
    return { fires: false, metric: "spread_sustained", threshold: spreadThreshold, observed: NaN };
  }

  // Find the latest spread value (most recent point)
  const sorted = [...relevant].sort((a, b) => a.ts - b.ts);
  const latest = sorted[sorted.length - 1]!;
  const latestSpread = Math.abs(latest.spread);

  // If the latest spread is not above the threshold, it can't be sustained
  if (latestSpread <= spreadThreshold) {
    return {
      fires: false,
      metric: "spread_sustained",
      threshold: spreadThreshold,
      observed: latestSpread,
    };
  }

  // Walk backwards from nowMs to find how long spread has been above threshold.
  // We need to find the earliest contiguous streak ending at nowMs where all
  // observed spreads exceed the threshold.
  const cutoff = nowMs - sustainMs;
  // All points within lookback window that matter
  const inWindow = sorted.filter((p) => p.ts >= cutoff && p.ts <= nowMs);

  // If there's a gap in coverage (no point at or before cutoff showing high spread),
  // check whether the streak started early enough.
  const streakStart = findStreakStart(sorted, spreadThreshold, nowMs);

  // The streak started at or before the sustain cutoff
  const fires = streakStart !== null && streakStart <= cutoff;

  void inWindow; // used only for clarity

  return {
    fires,
    metric: "spread_sustained",
    threshold: spreadThreshold,
    observed: latestSpread,
  };
}

/**
 * Finds the start timestamp of the latest contiguous streak where spread > threshold,
 * ending at or just before `nowMs`. Returns null if the latest point is not above threshold.
 */
function findStreakStart(
  sorted: SpreadPoint[],
  threshold: number,
  nowMs: number,
): number | null {
  // Work backwards from the most recent point
  const endIdx = sorted.findLastIndex((p) => p.ts <= nowMs);
  if (endIdx < 0) return null;
  if (Math.abs(sorted[endIdx]!.spread) <= threshold) return null;

  // Scan backwards while spread > threshold
  let i = endIdx;
  while (i > 0 && Math.abs(sorted[i - 1]!.spread) > threshold) {
    i--;
  }
  return sorted[i]!.ts;
}

// ---------------------------------------------------------------------------
// L2 trigger: pAbove + pBelow breakout probability
// ---------------------------------------------------------------------------

/**
 * Fires when pAbove + pBelow exceeds `threshold` (model signals high
 * probability of breaking out of the current range on either side).
 */
export function checkPBreakSum(
  pAbove: number,
  pBelow: number,
  threshold: number,
): TriggerResult {
  const observed = pAbove + pBelow;
  return {
    fires: observed > threshold,
    metric: "p_break_sum",
    threshold,
    observed,
  };
}

// ---------------------------------------------------------------------------
// L2 trigger: 24-hour PnL threshold
// ---------------------------------------------------------------------------

/**
 * Fires when `pnl24hPct` (as a fraction, e.g. -0.05 = -5%) is below the
 * configured threshold (also fractional, e.g. -0.05).
 */
export function checkPnl24h(pnl24hPct: number, threshold: number): TriggerResult {
  return {
    fires: pnl24hPct < threshold,
    metric: "pnl_24h_pct",
    threshold,
    observed: pnl24hPct,
  };
}

// ---------------------------------------------------------------------------
// L2 trigger: all data source outage (stale snapshot)
// ---------------------------------------------------------------------------

/**
 * Fires when the latest snapshot timestamp is more than `staleThresholdMs`
 * milliseconds behind `nowMs`. This represents a total data outage.
 */
export function checkDataOutage(
  snapshotTs: number | null,
  staleThresholdMs: number,
  nowMs: number,
): TriggerResult {
  if (snapshotTs === null) {
    return {
      fires: true,
      metric: "data_outage_staleness_ms",
      threshold: staleThresholdMs,
      observed: Infinity,
    };
  }
  const observed = nowMs - snapshotTs;
  return {
    fires: observed > staleThresholdMs,
    metric: "data_outage_staleness_ms",
    threshold: staleThresholdMs,
    observed,
  };
}

// ---------------------------------------------------------------------------
// Hysteresis / exit logic
// ---------------------------------------------------------------------------

export interface ExitExtremeInput {
  /** All L2 trigger results as of now. */
  triggerResults: TriggerResult[];
  /** Timestamp when EXTREME state was entered. */
  enteredAtMs: number;
  /** Required stable period before exiting (ms). Default: 10 min. */
  stableRequiredMs: number;
  /** Current time (epoch ms). */
  nowMs: number;
  /**
   * Recovery threshold for volatility (must drop below this before exit is
   * possible). Default: 0.07 (7%). Implements hysteresis: entered at 10%,
   * exits only when vol drops below 7%.
   */
  volatilityRecoveryThreshold: number;
  /**
   * Current 5-min volatility as a fraction (used for hysteresis check).
   * NaN means "no data" — treated as not having recovered.
   */
  currentVolatility5m: number;
}

/**
 * Returns true when it is safe to exit EXTREME state:
 *   1. No L2 trigger currently fires.
 *   2. Volatility has recovered below the hysteresis threshold (7%).
 *   3. The stable period (10 min) has elapsed since the last trigger fired.
 *
 * "Last trigger fired" is approximated as `enteredAtMs` since we don't track
 * individual trigger clearance timestamps. The state machine should call
 * this on every evaluation cycle.
 */
export function canExitExtreme(input: ExitExtremeInput): boolean {
  const { triggerResults, enteredAtMs, stableRequiredMs, nowMs, volatilityRecoveryThreshold, currentVolatility5m } = input;

  // 1. All triggers must be clear
  if (triggerResults.some((r) => r.fires)) return false;

  // 2. Volatility hysteresis: must have recovered below recovery threshold
  if (Number.isFinite(currentVolatility5m) && currentVolatility5m >= volatilityRecoveryThreshold) {
    return false;
  }

  // 3. Stable period must have elapsed since entering EXTREME
  const stableSince = enteredAtMs;
  if (nowMs - stableSince < stableRequiredMs) return false;

  return true;
}
