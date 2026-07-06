/**
 * tests/risk/circuits.test.ts
 *
 * Unit tests for src/risk/circuits.ts — pure L2 trigger functions.
 * Every test is deterministic via injected timestamps.
 */

import { describe, it, expect } from "bun:test";
import {
  checkVolatility5m,
  checkTvlDrop5m,
  checkSpreadSustained,
  checkPBreakSum,
  checkPnl24h,
  checkDataOutage,
  canExitExtreme,
  withinWindow,
  type PricePoint,
  type SpreadPoint,
  type TvlPoint,
  type TriggerResult,
} from "../../src/risk/circuits.ts";

const NOW = 1_700_000_000_000; // arbitrary fixed timestamp
const T = (offsetMs: number) => NOW + offsetMs;
const WINDOW_5M = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// withinWindow
// ---------------------------------------------------------------------------

describe("withinWindow", () => {
  it("returns only entries within the window", () => {
    const pts: PricePoint[] = [
      { ts: T(-6 * 60 * 1000), price: 1 }, // outside 5m
      { ts: T(-4 * 60 * 1000), price: 2 }, // inside
      { ts: T(-1 * 60 * 1000), price: 3 }, // inside
      { ts: T(0), price: 4 },              // at now (inside)
    ];
    const result = withinWindow(pts, NOW, WINDOW_5M);
    expect(result).toHaveLength(3);
    expect(result[0]!.price).toBe(2);
  });

  it("returns empty when all points are outside", () => {
    const pts: PricePoint[] = [
      { ts: T(-10 * 60 * 1000), price: 1 },
    ];
    expect(withinWindow(pts, NOW, WINDOW_5M)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// checkVolatility5m
// ---------------------------------------------------------------------------

describe("checkVolatility5m", () => {
  it("does not fire when fewer than 2 data points exist", () => {
    const result = checkVolatility5m([], 0.10, NOW);
    expect(result.fires).toBe(false);
    expect(Number.isNaN(result.observed)).toBe(true);
  });

  it("fires at exactly-at-threshold (strictly greater)", () => {
    // threshold 10%: (110 - 100) / 100 = 10%, should NOT fire (not strictly >)
    const window: PricePoint[] = [
      { ts: T(-3 * 60 * 1000), price: 100 },
      { ts: T(-1 * 60 * 1000), price: 110 },
    ];
    const result = checkVolatility5m(window, 0.10, NOW);
    expect(result.fires).toBe(false);
    expect(result.observed).toBeCloseTo(0.10);
  });

  it("fires above threshold", () => {
    // (115 - 100) / 100 = 15% > 10%
    const window: PricePoint[] = [
      { ts: T(-4 * 60 * 1000), price: 100 },
      { ts: T(-1 * 60 * 1000), price: 115 },
    ];
    const result = checkVolatility5m(window, 0.10, NOW);
    expect(result.fires).toBe(true);
    expect(result.observed).toBeCloseTo(0.15);
  });

  it("does not fire below threshold", () => {
    // (105 - 100) / 100 = 5% < 10%
    const window: PricePoint[] = [
      { ts: T(-4 * 60 * 1000), price: 100 },
      { ts: T(-1 * 60 * 1000), price: 105 },
    ];
    const result = checkVolatility5m(window, 0.10, NOW);
    expect(result.fires).toBe(false);
  });

  it("ignores points outside 5-minute window", () => {
    // Old point at -6m is outside window; only recent 2 points matter
    const window: PricePoint[] = [
      { ts: T(-6 * 60 * 1000), price: 50 }, // outside — would give huge vol if counted
      { ts: T(-4 * 60 * 1000), price: 100 },
      { ts: T(-1 * 60 * 1000), price: 103 }, // 3% vol, within threshold
    ];
    const result = checkVolatility5m(window, 0.10, NOW);
    expect(result.fires).toBe(false);
    expect(result.observed).toBeCloseTo(0.03);
  });

  it("metric is 'volatility_5m'", () => {
    const result = checkVolatility5m([], 0.10, NOW);
    expect(result.metric).toBe("volatility_5m");
  });
});

// ---------------------------------------------------------------------------
// checkTvlDrop5m
// ---------------------------------------------------------------------------

describe("checkTvlDrop5m", () => {
  it("does not fire when fewer than 2 points", () => {
    const result = checkTvlDrop5m([], 0.50, NOW);
    expect(result.fires).toBe(false);
    expect(Number.isNaN(result.observed)).toBe(true);
  });

  it("fires above threshold", () => {
    // TVL drops from 1000 to 400 = 60% drop > 50%
    const window: TvlPoint[] = [
      { ts: T(-4 * 60 * 1000), tvlUsd: 1000 },
      { ts: T(-1 * 60 * 1000), tvlUsd: 400 },
    ];
    const result = checkTvlDrop5m(window, 0.50, NOW);
    expect(result.fires).toBe(true);
    expect(result.observed).toBeCloseTo(0.60);
  });

  it("does not fire below threshold", () => {
    // 1000 to 600 = 40% drop < 50%
    const window: TvlPoint[] = [
      { ts: T(-4 * 60 * 1000), tvlUsd: 1000 },
      { ts: T(-1 * 60 * 1000), tvlUsd: 600 },
    ];
    const result = checkTvlDrop5m(window, 0.50, NOW);
    expect(result.fires).toBe(false);
  });

  it("does not fire when TVL increases", () => {
    const window: TvlPoint[] = [
      { ts: T(-4 * 60 * 1000), tvlUsd: 1000 },
      { ts: T(-1 * 60 * 1000), tvlUsd: 1500 },
    ];
    const result = checkTvlDrop5m(window, 0.50, NOW);
    expect(result.fires).toBe(false);
    expect(result.observed).toBeLessThan(0);
  });

  it("metric is 'tvl_drop_5m'", () => {
    const result = checkTvlDrop5m([], 0.50, NOW);
    expect(result.metric).toBe("tvl_drop_5m");
  });
});

// ---------------------------------------------------------------------------
// checkSpreadSustained
// ---------------------------------------------------------------------------

describe("checkSpreadSustained", () => {
  const SUSTAIN_MS = 30_000; // 30 seconds
  const SPREAD_THRESHOLD = 0.05; // 5%

  it("does not fire when spread is below threshold", () => {
    const window: SpreadPoint[] = [
      { ts: T(-60_000), spread: 0.03 },
      { ts: T(-30_000), spread: 0.03 },
      { ts: T(0), spread: 0.03 },
    ];
    const result = checkSpreadSustained(window, SPREAD_THRESHOLD, SUSTAIN_MS, NOW);
    expect(result.fires).toBe(false);
  });

  it("fires when spread exceeds threshold continuously for ≥ sustainMs", () => {
    // Spread has been >5% for 60+ seconds (longer than sustainMs=30s)
    const window: SpreadPoint[] = [
      { ts: T(-60_000), spread: 0.06 }, // 60s ago, above threshold
      { ts: T(-45_000), spread: 0.07 },
      { ts: T(-30_000), spread: 0.06 },
      { ts: T(-10_000), spread: 0.07 },
    ];
    const result = checkSpreadSustained(window, SPREAD_THRESHOLD, SUSTAIN_MS, NOW);
    expect(result.fires).toBe(true);
  });

  it("does not fire when spread just started exceeding threshold (< sustainMs)", () => {
    // Spread only high for 20s, less than 30s sustain requirement
    const window: SpreadPoint[] = [
      { ts: T(-45_000), spread: 0.03 }, // below threshold
      { ts: T(-20_000), spread: 0.06 }, // above: only 20s ago
      { ts: T(-5_000),  spread: 0.07 }, // above
    ];
    const result = checkSpreadSustained(window, SPREAD_THRESHOLD, SUSTAIN_MS, NOW);
    expect(result.fires).toBe(false);
  });

  it("does not fire when spread dipped below threshold mid-window", () => {
    // Streak broken at -20s
    const window: SpreadPoint[] = [
      { ts: T(-60_000), spread: 0.06 },
      { ts: T(-25_000), spread: 0.03 }, // dip below threshold — breaks streak
      { ts: T(-10_000), spread: 0.07 },
    ];
    const result = checkSpreadSustained(window, SPREAD_THRESHOLD, SUSTAIN_MS, NOW);
    expect(result.fires).toBe(false);
  });

  it("returns NaN observed when no data", () => {
    const result = checkSpreadSustained([], SPREAD_THRESHOLD, SUSTAIN_MS, NOW);
    expect(result.fires).toBe(false);
    expect(Number.isNaN(result.observed)).toBe(true);
  });

  it("metric is 'spread_sustained'", () => {
    const result = checkSpreadSustained([], SPREAD_THRESHOLD, SUSTAIN_MS, NOW);
    expect(result.metric).toBe("spread_sustained");
  });
});

// ---------------------------------------------------------------------------
// checkPBreakSum
// ---------------------------------------------------------------------------

describe("checkPBreakSum", () => {
  it("fires above threshold", () => {
    const result = checkPBreakSum(0.4, 0.4, 0.7);
    expect(result.fires).toBe(true);
    expect(result.observed).toBeCloseTo(0.8);
  });

  it("does not fire at threshold (strictly greater)", () => {
    const result = checkPBreakSum(0.35, 0.35, 0.7);
    expect(result.fires).toBe(false);
    expect(result.observed).toBeCloseTo(0.7);
  });

  it("does not fire below threshold", () => {
    const result = checkPBreakSum(0.2, 0.2, 0.7);
    expect(result.fires).toBe(false);
  });

  it("metric is 'p_break_sum'", () => {
    const result = checkPBreakSum(0.1, 0.1, 0.7);
    expect(result.metric).toBe("p_break_sum");
  });
});

// ---------------------------------------------------------------------------
// checkPnl24h
// ---------------------------------------------------------------------------

describe("checkPnl24h", () => {
  it("fires when pnl is below threshold", () => {
    const result = checkPnl24h(-0.06, -0.05);
    expect(result.fires).toBe(true);
    expect(result.observed).toBeCloseTo(-0.06);
  });

  it("does not fire when pnl equals threshold (strictly less than)", () => {
    const result = checkPnl24h(-0.05, -0.05);
    expect(result.fires).toBe(false);
  });

  it("does not fire when pnl is positive", () => {
    const result = checkPnl24h(0.02, -0.05);
    expect(result.fires).toBe(false);
  });

  it("metric is 'pnl_24h_pct'", () => {
    const result = checkPnl24h(0, -0.05);
    expect(result.metric).toBe("pnl_24h_pct");
  });
});

// ---------------------------------------------------------------------------
// checkDataOutage
// ---------------------------------------------------------------------------

describe("checkDataOutage", () => {
  it("fires when snapshotTs is null (no data ever received)", () => {
    const result = checkDataOutage(null, 60_000, NOW);
    expect(result.fires).toBe(true);
    expect(result.observed).toBe(Infinity);
  });

  it("fires when snapshot is older than stale threshold", () => {
    const result = checkDataOutage(T(-90_000), 60_000, NOW); // 90s old, threshold 60s
    expect(result.fires).toBe(true);
    expect(result.observed).toBeCloseTo(90_000);
  });

  it("does not fire when snapshot is fresh", () => {
    const result = checkDataOutage(T(-10_000), 60_000, NOW); // 10s old, threshold 60s
    expect(result.fires).toBe(false);
    expect(result.observed).toBeCloseTo(10_000);
  });

  it("does not fire exactly at threshold (strictly greater)", () => {
    const result = checkDataOutage(T(-60_000), 60_000, NOW);
    expect(result.fires).toBe(false);
  });

  it("metric is 'data_outage_staleness_ms'", () => {
    const result = checkDataOutage(null, 60_000, NOW);
    expect(result.metric).toBe("data_outage_staleness_ms");
  });
});

// ---------------------------------------------------------------------------
// canExitExtreme — hysteresis and stable period
// ---------------------------------------------------------------------------

describe("canExitExtreme", () => {
  const ALL_CLEAR: TriggerResult[] = [
    { fires: false, metric: "volatility_5m", threshold: 0.10, observed: 0.03 },
    { fires: false, metric: "tvl_drop_5m", threshold: 0.50, observed: 0.05 },
    { fires: false, metric: "spread_sustained", threshold: 0.05, observed: 0.01 },
  ];

  const STABLE_10M = 10 * 60 * 1000;

  it("returns true when all conditions are met", () => {
    const entered = T(-STABLE_10M - 1); // just past 10m ago
    expect(
      canExitExtreme({
        triggerResults: ALL_CLEAR,
        enteredAtMs: entered,
        stableRequiredMs: STABLE_10M,
        nowMs: NOW,
        volatilityRecoveryThreshold: 0.07,
        currentVolatility5m: 0.04, // below 7% recovery threshold
      }),
    ).toBe(true);
  });

  it("returns false when a trigger still fires", () => {
    const firingResults: TriggerResult[] = [
      ...ALL_CLEAR,
      { fires: true, metric: "volatility_5m", threshold: 0.10, observed: 0.12 },
    ];
    expect(
      canExitExtreme({
        triggerResults: firingResults,
        enteredAtMs: T(-STABLE_10M - 1),
        stableRequiredMs: STABLE_10M,
        nowMs: NOW,
        volatilityRecoveryThreshold: 0.07,
        currentVolatility5m: 0.04,
      }),
    ).toBe(false);
  });

  it("returns false when stable period has not elapsed (anti-flapping)", () => {
    const entered = T(-5 * 60 * 1000); // only 5 min ago, need 10 min
    expect(
      canExitExtreme({
        triggerResults: ALL_CLEAR,
        enteredAtMs: entered,
        stableRequiredMs: STABLE_10M,
        nowMs: NOW,
        volatilityRecoveryThreshold: 0.07,
        currentVolatility5m: 0.04,
      }),
    ).toBe(false);
  });

  it("returns false when volatility has not recovered below hysteresis threshold", () => {
    // Volatility at 8%, above the 7% recovery threshold (hysteresis)
    const entered = T(-STABLE_10M - 1);
    expect(
      canExitExtreme({
        triggerResults: ALL_CLEAR,
        enteredAtMs: entered,
        stableRequiredMs: STABLE_10M,
        nowMs: NOW,
        volatilityRecoveryThreshold: 0.07,
        currentVolatility5m: 0.08,
      }),
    ).toBe(false);
  });

  it("returns true when volatility is exactly at recovery threshold (strictly less)", () => {
    // currentVolatility5m = 0.07 = threshold: canExit checks >= threshold
    // 0.07 >= 0.07 is true → should return false
    const entered = T(-STABLE_10M - 1);
    expect(
      canExitExtreme({
        triggerResults: ALL_CLEAR,
        enteredAtMs: entered,
        stableRequiredMs: STABLE_10M,
        nowMs: NOW,
        volatilityRecoveryThreshold: 0.07,
        currentVolatility5m: 0.07,
      }),
    ).toBe(false);
  });

  it("blocks exit when volatility is NaN (no data — NOT recovered)", () => {
    // Exiting the protective state while blind would invert the hysteresis's
    // purpose. NaN (insufficient price data) must keep EXTREME latched until
    // real observations show recovery. (Matches the ExitExtremeInput doc;
    // the previous treat-NaN-as-recovered behaviour was the bug.)
    const entered = T(-STABLE_10M - 1);
    expect(
      canExitExtreme({
        triggerResults: ALL_CLEAR,
        enteredAtMs: entered,
        stableRequiredMs: STABLE_10M,
        nowMs: NOW,
        volatilityRecoveryThreshold: 0.07,
        currentVolatility5m: NaN,
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Phase 1 additions — checkSourceStaleness
// ---------------------------------------------------------------------------

import { checkSourceStaleness } from "../../src/risk/circuits.ts";

describe("checkSourceStaleness", () => {
  const THRESH = { suiMs: 60_000, cetusMs: 180_000, derivMs: 600_000 };
  const NOW2 = 1_700_000_000_000;

  it("null input returns three non-firing results with NaN observed", () => {
    const results = checkSourceStaleness(null, THRESH, NOW2);
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.fires).toBe(false);
      expect(Number.isNaN(r.observed)).toBe(true);
    }
  });

  it("fires only the source over its threshold", () => {
    const results = checkSourceStaleness(
      { capturedAtMs: NOW2, sui: 5_000, cetus: 240_000, derivatives: 10_000 },
      THRESH,
      NOW2,
    );
    const byMetric = new Map(results.map((r) => [r.metric, r]));
    expect(byMetric.get("source_stale_sui")!.fires).toBe(false);
    expect(byMetric.get("source_stale_cetus")!.fires).toBe(true);
    expect(byMetric.get("source_stale_derivatives")!.fires).toBe(false);
  });

  it("the sample ages: recorded age + time since capture", () => {
    // Recorded 30s stale, captured 40s ago → effective 70s > 60s threshold.
    const results = checkSourceStaleness(
      { capturedAtMs: NOW2 - 40_000, sui: 30_000, cetus: 0, derivatives: 0 },
      THRESH,
      NOW2,
    );
    const sui = results.find((r) => r.metric === "source_stale_sui")!;
    expect(sui.observed).toBe(70_000);
    expect(sui.fires).toBe(true);
  });

  it("never-updated sentinel (MAX_SAFE_INTEGER) fires", () => {
    const results = checkSourceStaleness(
      { capturedAtMs: NOW2, sui: Number.MAX_SAFE_INTEGER, cetus: 0, derivatives: 0 },
      THRESH,
      NOW2,
    );
    expect(results.find((r) => r.metric === "source_stale_sui")!.fires).toBe(true);
  });

  it("exact threshold does not fire (strictly greater)", () => {
    const results = checkSourceStaleness(
      { capturedAtMs: NOW2, sui: 60_000, cetus: 0, derivatives: 0 },
      THRESH,
      NOW2,
    );
    expect(results.find((r) => r.metric === "source_stale_sui")!.fires).toBe(false);
  });
});
