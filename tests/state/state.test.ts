/**
 * Tests for src/state/ — three-state machine (NORMAL / TREND / EXTREME).
 *
 * Coverage:
 *   1. params.ts — derivation functions with clamps and boundary values.
 *   2. transitions.ts — computeDriftStrength, individual predicates.
 *   3. transitions.ts — transition matrix scenarios.
 *   4. machine.ts — state transitions, DB persistence, EXTREME evalInterval/
 *      lendingPct, min-dwell enforcement, no flapping.
 *
 * All tests are deterministic — `now` is always injected.  No network calls.
 * DB is opened on an in-memory path so there is no on-disk state.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  deriveHalfWidth,
  deriveToleranceBins,
  deriveTrendBias,
  deriveLendingPct,
  DEFAULT_STATE_PARAMS,
  HALF_WIDTH_MIN,
  HALF_WIDTH_MAX,
  EVAL_INTERVAL_MS,
  MIN_DWELL_MS,
  TREND_BIAS_NORMALISER,
  LENDING_PCT_BASE,
} from "../../src/state/params.ts";

import {
  computeDriftStrength,
  dwellElapsed,
  shouldEnterTrend,
  shouldExitTrend,
  shouldEnterExtreme,
  shouldExitExtreme,
  type ExtremeSignal,
} from "../../src/state/transitions.ts";

import { createStateMachine } from "../../src/state/machine.ts";

import type {
  MarketSnapshot,
  PredictionResponse,
  OhlcvBar,
  MarketState,
} from "../../src/prediction/types.ts";
import type { StrategyInput } from "../../src/strategies/types.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeBar(ts: number, close: number): OhlcvBar {
  return { ts, open: close, high: close * 1.001, low: close * 0.999, close, volume: 1000 };
}

/** Build a bar sequence with a constant close price. */
function flatBars(n: number, price = 2.5): OhlcvBar[] {
  return Array.from({ length: n }, (_, i) => makeBar(i * 60_000, price));
}

/**
 * Build a bar sequence with a constant return per bar.
 * `stepFraction` is the fraction change from bar i to bar i+1.
 */
function trendingBars(n: number, basePrice: number, stepFraction: number): OhlcvBar[] {
  const bars: OhlcvBar[] = [];
  let p = basePrice;
  for (let i = 0; i < n; i++) {
    bars.push(makeBar(i * 60_000, p));
    p = p * (1 + stepFraction);
  }
  return bars;
}

/**
 * Build bars designed to produce a high drift_strength:
 * first `nFlat` bars are flat (low background σ), then 2 large-move bars on top.
 * The last bar and second-to-last bar are the "signal" bars.
 * Background σ_ewm ≈ `flatStep`; signal returns ≈ `spike`.
 * drift_strength = (|spike| + |spike|) / (2 × σ_ewm) >> 1 when spike >> flatStep.
 */
function highDriftBars(
  nFlat: number,
  basePrice: number,
  flatStep: number,
  spike: number,
): OhlcvBar[] {
  // n-3 background bars with small step, then spike on bar n-2 and n-1
  // bars[0..nFlat+1] are background; bars[nFlat+2] and bars[nFlat+3] are signal
  const bars: OhlcvBar[] = [];
  let p = basePrice;
  for (let i = 0; i < nFlat + 2; i++) {
    bars.push(makeBar(i * 60_000, p));
    p = p * (1 + flatStep);
  }
  // Add two large-spike signal bars
  const p2 = p * (1 + spike);
  const p3 = p2 * (1 + spike);
  bars.push(makeBar((nFlat + 2) * 60_000, p2));
  bars.push(makeBar((nFlat + 3) * 60_000, p3));
  return bars;
}

function makeSnapshot(suiBars: OhlcvBar[]): MarketSnapshot {
  return {
    ts: 1_700_000_000_000,
    cetus: { activeBin: 1000, price: "2.50", tvlUsd: 500_000, binStep: 10 },
    binance: {
      sui: suiBars,
      btc: flatBars(30, 65_000),
      eth: flatBars(30, 3_500),
    },
    derivatives: { funding: 0.0001, oi: 5_000_000, liq1m: 10_000 },
    spread: 0.001,
  };
}

function makePred(overrides: Partial<PredictionResponse> = {}): PredictionResponse {
  return {
    widthSigma: 2.0,
    pAbove: 0.3,
    pBelow: 0.3,
    modelVersion: "null-v0",
    featureCompleteness: 1.0,
    psi: 0.0,
    fallback: false,
    ...overrides,
  };
}

/** Minimal StrategyInput stub — machine only uses pool.activeBinId. */
function makeInput(): StrategyInput {
  return {
    pm: {
      pmId: "0xpm",
      owner: "0xowner",
      poolId: "0xpool",
      coinTypeA: "0x2::sui::SUI",
      coinTypeB: "0x5d4b302506645c37ff133b98c4b50a4aa6...",
      balance: { a: 0n, b: 0n },
      feeBag: { a: 0n, b: 0n },
      positionBins: [],
      lending: { scallop: {}, kai: {} },
    },
    pool: {
      poolId: "0xpool",
      activeBinId: 1000,
      binStep: 10,
      feeRateBps: 40,
    },
    spot: { price: "2.50", timestampMs: 0, source: "onchain" },
    history: [],
    profile: {
      name: "sui-usdc",
      network: "mainnet",
      poolId: "0xpool",
      coinTypeA: "0x2::sui::SUI",
      coinTypeB: "0x5d4b302506645c37ff133b98c4b50a4aa6...",
      decimalsA: 9,
      decimalsB: 6,
      binStep: 10,
      pricePairLabel: "SUI/USDC",
      defaultStrategyParams: { binWidth: 10, expectedFeeBps: 40 },
      lendingPolicy: {},
    },
  };
}

/** Open an in-memory SQLite DB with the full schema applied. */
function openTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(resolve(here, "../../src/db/schema.sql"), "utf8");
  db.exec(sql);
  return db;
}

/** Query all state history rows for a pool, ordered by entered_at_ms. */
function getRows(db: Database, poolId: string) {
  return db
    .prepare(
      `SELECT id, pool_id, entered_at_ms, exited_at_ms, state, trigger, prev_state
       FROM market_state_history
       WHERE pool_id = ?
       ORDER BY entered_at_ms ASC`,
    )
    .all(poolId) as Array<{
      id: number;
      pool_id: string;
      entered_at_ms: number;
      exited_at_ms: number | null;
      state: string;
      trigger: string;
      prev_state: string | null;
    }>;
}

// ---------------------------------------------------------------------------
// 1. params.ts — derivation functions
// ---------------------------------------------------------------------------

describe("deriveHalfWidth", () => {
  it("clamps to HALF_WIDTH_MIN when widthSigma is very small", () => {
    expect(deriveHalfWidth(0)).toBe(HALF_WIDTH_MIN);
    expect(deriveHalfWidth(0.1)).toBe(HALF_WIDTH_MIN);
  });

  it("clamps to HALF_WIDTH_MAX when widthSigma is very large", () => {
    expect(deriveHalfWidth(100)).toBe(HALF_WIDTH_MAX);
    expect(deriveHalfWidth(10)).toBe(HALF_WIDTH_MAX);
  });

  it("midpoint: widthSigma=2.0 → round(2.0 × 2.0)=4", () => {
    expect(deriveHalfWidth(2.0)).toBe(4);
  });

  it("widthSigma=1.5 → round(3.0)=3", () => {
    expect(deriveHalfWidth(1.5)).toBe(3);
  });

  it("widthSigma=1.3 → round(2.6)=3", () => {
    expect(deriveHalfWidth(1.3)).toBe(3);
  });

  it("widthSigma=1.0 → round(2.0)=2=HALF_WIDTH_MIN", () => {
    expect(deriveHalfWidth(1.0)).toBe(HALF_WIDTH_MIN);
  });

  it("boundary: widthSigma=4.0 → round(8)=8=HALF_WIDTH_MAX", () => {
    expect(deriveHalfWidth(4.0)).toBe(HALF_WIDTH_MAX);
  });

  it("just above max: widthSigma=4.01 → clamps to 8", () => {
    expect(deriveHalfWidth(4.01)).toBe(HALF_WIDTH_MAX);
  });

  it("result is always in [HALF_WIDTH_MIN, HALF_WIDTH_MAX]", () => {
    for (const sigma of [0, 0.5, 1, 1.5, 2, 3, 4, 5, 10]) {
      const hw = deriveHalfWidth(sigma);
      expect(hw).toBeGreaterThanOrEqual(HALF_WIDTH_MIN);
      expect(hw).toBeLessThanOrEqual(HALF_WIDTH_MAX);
    }
  });

  it("uses K_W multiplier", () => {
    // K_W=2.0, so widthSigma=1.75 → round(3.5)=4
    expect(deriveHalfWidth(1.75)).toBe(Math.max(HALF_WIDTH_MIN, Math.min(HALF_WIDTH_MAX, Math.round(DEFAULT_STATE_PARAMS.kW * 1.75))));
  });
});

describe("deriveToleranceBins", () => {
  it("minimum is 1 (half width large enough that cap doesn't bite)", () => {
    expect(deriveToleranceBins(0, 8)).toBe(1);
    expect(deriveToleranceBins(0.4, 8)).toBe(1);
  });

  it("rounds to nearest integer", () => {
    expect(deriveToleranceBins(1.4, 8)).toBe(1);
    expect(deriveToleranceBins(1.5, 8)).toBe(2);
    expect(deriveToleranceBins(2.0, 8)).toBe(2);
  });

  it("wider sigma → more tolerance (when halfWidth is large enough)", () => {
    expect(deriveToleranceBins(3.0, 8)).toBeGreaterThan(deriveToleranceBins(1.0, 8));
  });

  it("caps at halfWidth — tolerance cannot exceed the range half-width (F4)", () => {
    // widthSigma=5 → raw=5, but halfWidth=3 → cap at 3
    expect(deriveToleranceBins(5, 3)).toBe(3);
    // widthSigma=2 → raw=2, halfWidth=8 → no cap needed
    expect(deriveToleranceBins(2, 8)).toBe(2);
  });

  it("cap prevents permanently-true tolerance guard at high vol (F4 regression)", () => {
    // At real SUI vol, widthSigma can be >> HALF_WIDTH_MAX (8).
    // Without the cap, toleranceBins=10 with halfWidth=4 would mean the guard
    // is always null (drift can never exceed 10 when max drift = halfWidth = 4).
    const halfWidth = 4;
    const highSigma = 10;
    const tol = deriveToleranceBins(highSigma, halfWidth);
    expect(tol).toBeLessThanOrEqual(halfWidth);
  });
});

// describe("deriveMaxCenterOffset") removed with the center prediction head (docs/decision-remove-center-prediction.md)

describe("deriveTrendBias", () => {
  it("symmetric: pAbove=pBelow → 0", () => {
    expect(deriveTrendBias(0.3, 0.3)).toBe(0);
    expect(deriveTrendBias(0.5, 0.5)).toBeCloseTo(0, 10);
  });

  it("full bullish: pAbove=0.5, pBelow=0 → 1", () => {
    expect(deriveTrendBias(0.5, 0)).toBe(1);
  });

  it("full bearish: pAbove=0, pBelow=0.5 → -1", () => {
    expect(deriveTrendBias(0, 0.5)).toBe(-1);
  });

  it("clamps at +1 when (pAbove-pBelow)/0.5 > 1", () => {
    expect(deriveTrendBias(1.0, 0)).toBe(1);
  });

  it("clamps at -1 when (pAbove-pBelow)/0.5 < -1", () => {
    expect(deriveTrendBias(0, 1.0)).toBe(-1);
  });

  it("uses TREND_BIAS_NORMALISER (0.5)", () => {
    // (0.4 - 0.1) / 0.5 = 0.6
    expect(deriveTrendBias(0.4, 0.1)).toBeCloseTo(0.6, 10);
  });

  it("TREND_BIAS_NORMALISER constant is 0.5", () => {
    expect(TREND_BIAS_NORMALISER).toBe(0.5);
  });
});

describe("deriveLendingPct", () => {
  it("NORMAL → 35% (no L1 bonus in state machine — F6)", () => {
    expect(deriveLendingPct("NORMAL", 0)).toBeCloseTo(0.35, 10);
  });

  it("L1 bonus is applied externally (mlAgent veto path), not in params (F6)", () => {
    // The bonus is NOT in deriveLendingPct. 35% + 10pp = 45% is computed in mlAgent.
    expect(deriveLendingPct("NORMAL", 0)).toBeCloseTo(LENDING_PCT_BASE.NORMAL, 10);
  });

  it("EXTREME → always 1.0 regardless of trendBias", () => {
    expect(deriveLendingPct("EXTREME", 0)).toBe(1.0);
    expect(deriveLendingPct("EXTREME", 1)).toBe(1.0);
    expect(deriveLendingPct("EXTREME", -1)).toBe(1.0);
  });

  it("TREND with trendBias=0 → 50%", () => {
    expect(deriveLendingPct("TREND", 0)).toBeCloseTo(0.50, 10);
  });

  it("TREND with trendBias=1 → 70%", () => {
    expect(deriveLendingPct("TREND", 1)).toBeCloseTo(0.70, 10);
  });

  it("TREND with trendBias=-1 → 70% (abs value)", () => {
    expect(deriveLendingPct("TREND", -1)).toBeCloseTo(0.70, 10);
  });

  it("TREND with trendBias=0.5 → 60%", () => {
    // 0.50 + 0.20 × 0.5 = 0.60
    expect(deriveLendingPct("TREND", 0.5)).toBeCloseTo(0.60, 10);
  });

  it("result is always in [0, 1]", () => {
    for (const state of ["NORMAL", "TREND", "EXTREME"] as MarketState[]) {
      for (const bias of [-1, -0.5, 0, 0.5, 1]) {
        const v = deriveLendingPct(state, bias);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("EVAL_INTERVAL_MS constants", () => {
  it("NORMAL = 20 min", () => {
    expect(EVAL_INTERVAL_MS.NORMAL).toBe(20 * 60 * 1_000);
  });
  it("TREND = 15 min", () => {
    expect(EVAL_INTERVAL_MS.TREND).toBe(15 * 60 * 1_000);
  });
  it("EXTREME = 1 min", () => {
    expect(EVAL_INTERVAL_MS.EXTREME).toBe(60 * 1_000);
  });
});

describe("MIN_DWELL_MS constants", () => {
  it("NORMAL = 15 min", () => {
    expect(MIN_DWELL_MS.NORMAL).toBe(15 * 60 * 1_000);
  });
  it("TREND = 15 min", () => {
    expect(MIN_DWELL_MS.TREND).toBe(15 * 60 * 1_000);
  });
  it("EXTREME = 10 min", () => {
    expect(MIN_DWELL_MS.EXTREME).toBe(10 * 60 * 1_000);
  });
});

// ---------------------------------------------------------------------------
// 2. transitions.ts — computeDriftStrength
// ---------------------------------------------------------------------------

describe("computeDriftStrength", () => {
  it("returns 0 when fewer than 4 bars", () => {
    expect(computeDriftStrength(makeSnapshot([]))).toBe(0);
    expect(computeDriftStrength(makeSnapshot(flatBars(1)))).toBe(0);
    expect(computeDriftStrength(makeSnapshot(flatBars(2)))).toBe(0);
    expect(computeDriftStrength(makeSnapshot(flatBars(3)))).toBe(0);
  });

  it("returns > 0 for bars with any non-flat signal bars", () => {
    // Background: flat, spike bars: 5%
    const bars = highDriftBars(10, 2.5, 0, 0.05);
    const ds = computeDriftStrength(makeSnapshot(bars));
    expect(ds).toBeGreaterThan(0);
  });

  it("returns 0 for perfectly flat prices (all returns 0, signal bars 0 too)", () => {
    const bars = flatBars(30, 2.5);
    const ds = computeDriftStrength(makeSnapshot(bars));
    // All returns 0 → ewma → 0 → numerator 0 / FLOOR = 0
    expect(ds).toBe(0);
  });

  it("large spike bars relative to flat background produces drift_strength > 2.0", () => {
    // Background: 0.01% per bar; signal bars: 3% each
    // background σ ≈ 0.0001; signal ≈ 0.03 → ratio ≈ 0.03/(0.0001) = 300
    const bars = highDriftBars(20, 2.5, 0.0001, 0.03);
    const ds = computeDriftStrength(makeSnapshot(bars));
    expect(ds).toBeGreaterThan(2.0);
  });

  it("small signal bars relative to volatile background produces drift_strength < 2.0", () => {
    // Background: 1% per bar (high vol); signal bars: 0.1% (small)
    const bars = highDriftBars(20, 2.5, 0.01, 0.001);
    const ds = computeDriftStrength(makeSnapshot(bars));
    expect(ds).toBeLessThan(2.0);
  });

  it("is positive for any non-flat series with 4+ bars", () => {
    const bars = highDriftBars(3, 2.5, 0, 0.01);
    expect(computeDriftStrength(makeSnapshot(bars))).toBeGreaterThan(0);
  });
});

describe("dwellElapsed", () => {
  it("returns false before dwell time has passed", () => {
    const enteredAt = 0;
    // 1 second into a 15-min dwell
    expect(dwellElapsed("NORMAL", enteredAt, 1_000)).toBe(false);
    expect(dwellElapsed("TREND", enteredAt, 1_000)).toBe(false);
    expect(dwellElapsed("EXTREME", enteredAt, 1_000)).toBe(false);
  });

  it("returns true exactly at the dwell boundary", () => {
    const enteredAt = 0;
    expect(dwellElapsed("NORMAL", enteredAt, MIN_DWELL_MS.NORMAL)).toBe(true);
    expect(dwellElapsed("TREND", enteredAt, MIN_DWELL_MS.TREND)).toBe(true);
    expect(dwellElapsed("EXTREME", enteredAt, MIN_DWELL_MS.EXTREME)).toBe(true);
  });

  it("returns true after dwell time has passed", () => {
    const enteredAt = 0;
    expect(dwellElapsed("NORMAL", enteredAt, MIN_DWELL_MS.NORMAL + 1)).toBe(true);
  });

  it("EXTREME dwell is shorter than NORMAL/TREND", () => {
    expect(MIN_DWELL_MS.EXTREME).toBeLessThan(MIN_DWELL_MS.NORMAL);
  });
});

// ---------------------------------------------------------------------------
// 3. transitions.ts — shouldEnterTrend, shouldExitTrend, shouldEnterExtreme, shouldExitExtreme
// ---------------------------------------------------------------------------

describe("shouldEnterTrend", () => {
  it("returns true when drift_strength > 2.0 (spike bars vs flat background)", () => {
    // Flat background (0.01%), large spike (3%) → drift >> 2.0
    const bars = highDriftBars(20, 2.5, 0.0001, 0.03);
    const pred = makePred({ pAbove: 0.3, pBelow: 0.3 });  // p_break below threshold
    expect(shouldEnterTrend(makeSnapshot(bars), pred)).toBe(true);
  });

  it("returns true when max(pAbove, pBelow) > 0.6 (pAbove=0.65, pBelow=0.04, sum<0.7)", () => {
    // Use values where max(p,p) > 0.6 but sum < 0.7 so EXTREME is not triggered
    const bars = flatBars(30);  // drift_strength = 0
    const pred = makePred({ pAbove: 0.65, pBelow: 0.04 });  // sum=0.69 < 0.7
    expect(shouldEnterTrend(makeSnapshot(bars), pred)).toBe(true);
  });

  it("returns true when pBelow > 0.6", () => {
    const bars = flatBars(30);
    const pred = makePred({ pAbove: 0.04, pBelow: 0.65 });  // sum=0.69 < 0.7
    expect(shouldEnterTrend(makeSnapshot(bars), pred)).toBe(true);
  });

  it("returns false when drift is low and p_break is below 0.6", () => {
    const bars = flatBars(30);
    const pred = makePred({ pAbove: 0.3, pBelow: 0.3 });
    expect(shouldEnterTrend(makeSnapshot(bars), pred)).toBe(false);
  });

  it("exactly at threshold: max(pAbove,pBelow)=0.6 does NOT trigger (> not >=)", () => {
    const bars = flatBars(30);
    const pred = makePred({ pAbove: 0.6, pBelow: 0.09 });  // sum = 0.69, max = 0.6
    expect(shouldEnterTrend(makeSnapshot(bars), pred)).toBe(false);
  });
});

describe("shouldExitTrend", () => {
  it("returns true when drift_strength is low and p_break is below 0.6", () => {
    const bars = flatBars(30);  // drift ≈ 0
    const pred = makePred({ pAbove: 0.3, pBelow: 0.3 });
    expect(shouldExitTrend(makeSnapshot(bars), pred)).toBe(true);
  });

  it("returns false when drift_strength is still above 1.5 (spike bars)", () => {
    // Large spike relative to tiny background → drift >> 1.5
    const bars = highDriftBars(20, 2.5, 0.0001, 0.03);
    const pred = makePred({ pAbove: 0.3, pBelow: 0.3 });
    expect(shouldExitTrend(makeSnapshot(bars), pred)).toBe(false);
  });

  it("returns false when p_break is still above 0.6", () => {
    const bars = flatBars(30);  // drift ≈ 0
    const pred = makePred({ pAbove: 0.65, pBelow: 0.04 });  // max = 0.65 > 0.6
    expect(shouldExitTrend(makeSnapshot(bars), pred)).toBe(false);
  });
});

describe("shouldEnterExtreme", () => {
  it("returns enter=true when extremeSignal is active", () => {
    const pred = makePred({ pAbove: 0.1, pBelow: 0.1 });
    const signal: ExtremeSignal = { active: true, trigger: "tvl_drop_5m" };
    const result = shouldEnterExtreme(pred, signal);
    expect(result.enter).toBe(true);
    expect(result.trigger).toBe("tvl_drop_5m");
  });

  it("returns enter=true when pAbove+pBelow > 0.7", () => {
    const pred = makePred({ pAbove: 0.4, pBelow: 0.35 });  // sum = 0.75
    const result = shouldEnterExtreme(pred, null);
    expect(result.enter).toBe(true);
    expect(result.trigger).toContain("p_break_sum");
  });

  it("returns enter=false when p-sum is exactly 0.7 (> not >=)", () => {
    const pred = makePred({ pAbove: 0.35, pBelow: 0.35 });  // sum = 0.70
    const result = shouldEnterExtreme(pred, null);
    expect(result.enter).toBe(false);
  });

  it("returns enter=false when signal inactive and p-sum is low", () => {
    const pred = makePred({ pAbove: 0.3, pBelow: 0.3 });
    const signal: ExtremeSignal = { active: false, trigger: "" };
    const result = shouldEnterExtreme(pred, signal);
    expect(result.enter).toBe(false);
  });

  it("returns enter=false when no signal and p-sum is low", () => {
    const pred = makePred({ pAbove: 0.3, pBelow: 0.3 });
    const result = shouldEnterExtreme(pred, undefined);
    expect(result.enter).toBe(false);
  });
});

describe("shouldExitExtreme", () => {
  const EXTREME_DWELL = MIN_DWELL_MS.EXTREME;  // 10 min

  it("returns true when all conditions met", () => {
    const pred = makePred({ pAbove: 0.2, pBelow: 0.2 });  // sum = 0.4
    expect(
      shouldExitExtreme(pred, null, true, 0, EXTREME_DWELL + 1),
    ).toBe(true);
  });

  it("returns false when signal is still active", () => {
    const pred = makePred({ pAbove: 0.2, pBelow: 0.2 });
    const signal: ExtremeSignal = { active: true, trigger: "still_active" };
    expect(
      shouldExitExtreme(pred, signal, true, 0, EXTREME_DWELL + 1),
    ).toBe(false);
  });

  it("returns false when p-sum is still > 0.7", () => {
    const pred = makePred({ pAbove: 0.4, pBelow: 0.35 });  // sum = 0.75
    expect(
      shouldExitExtreme(pred, null, true, 0, EXTREME_DWELL + 1),
    ).toBe(false);
  });

  it("returns false when stability window not met", () => {
    const pred = makePred({ pAbove: 0.2, pBelow: 0.2 });
    // 5 min < 10 min minimum
    expect(
      shouldExitExtreme(pred, null, true, 0, 5 * 60 * 1_000),
    ).toBe(false);
  });

  it("returns false when volatility has not recovered", () => {
    const pred = makePred({ pAbove: 0.2, pBelow: 0.2 });
    expect(
      shouldExitExtreme(pred, null, false, 0, EXTREME_DWELL + 1),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. machine.ts — state machine integration tests
// ---------------------------------------------------------------------------

describe("StateMachine — initial state", () => {
  let db: Database;
  beforeEach(() => { db = openTestDb(); });
  afterEach(() => { db.close(); });

  it("starts in NORMAL state", () => {
    const sm = createStateMachine({ poolId: "0xpool", db, now: () => 0 });
    expect(sm.current().state).toBe("NORMAL");
  });

  it("initial evalIntervalMs is 20 min", () => {
    const sm = createStateMachine({ poolId: "0xpool", db, now: () => 0 });
    expect(sm.current().evalIntervalMs).toBe(20 * 60 * 1_000);
  });

  it("inserts an initial DB row on creation", () => {
    createStateMachine({ poolId: "0xpool", db, now: () => 0 });
    const rows = getRows(db, "0xpool");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("NORMAL");
    expect(rows[0]!.exited_at_ms).toBeNull();
    expect(rows[0]!.prev_state).toBeNull();
  });
});

describe("StateMachine — NORMAL → TREND transition", () => {
  let db: Database;
  beforeEach(() => { db = openTestDb(); });
  afterEach(() => { db.close(); });

  it("transitions to TREND after dwell when drift_strength > 2.0", () => {
    let t = 0;
    const sm = createStateMachine({ poolId: "pool1", db, now: () => t });

    // Advance past NORMAL min-dwell (15 min)
    t = MIN_DWELL_MS.NORMAL + 1_000;
    // Flat background + large spike → drift >> 2.0; p_break below threshold
    const bars = highDriftBars(20, 2.5, 0.0001, 0.03);
    const snap = makeSnapshot(bars);
    const pred = makePred({ pAbove: 0.3, pBelow: 0.3 });
    const ctx = sm.advance(snap, pred, makeInput());

    expect(ctx.state).toBe("TREND");
    expect(ctx.evalIntervalMs).toBe(15 * 60 * 1_000);
  });

  it("transitions to TREND after dwell when max(pAbove,pBelow) > 0.6 (sum < 0.7)", () => {
    let t = 0;
    const sm = createStateMachine({ poolId: "pool2", db, now: () => t });

    t = MIN_DWELL_MS.NORMAL + 1_000;
    const snap = makeSnapshot(flatBars(30));
    // pAbove=0.65, pBelow=0.04: max=0.65 > 0.6, sum=0.69 < 0.7 (no EXTREME)
    const pred = makePred({ pAbove: 0.65, pBelow: 0.04 });
    const ctx = sm.advance(snap, pred, makeInput());

    expect(ctx.state).toBe("TREND");
  });

  it("does NOT transition before NORMAL min-dwell has elapsed", () => {
    let t = 0;
    const sm = createStateMachine({ poolId: "pool3", db, now: () => t });

    t = MIN_DWELL_MS.NORMAL - 1_000;  // 1 second short
    const bars = highDriftBars(20, 2.5, 0.0001, 0.03);
    const pred = makePred({ pAbove: 0.3, pBelow: 0.3 });
    const ctx = sm.advance(makeSnapshot(bars), pred, makeInput());

    expect(ctx.state).toBe("NORMAL");
  });
});

describe("StateMachine — → EXTREME transition", () => {
  let db: Database;
  beforeEach(() => { db = openTestDb(); });
  afterEach(() => { db.close(); });

  it("transitions from NORMAL to EXTREME via injected risk signal", () => {
    let t = 0;
    const sm = createStateMachine({ poolId: "poolE1", db, now: () => t });

    t = MIN_DWELL_MS.NORMAL + 1_000;
    const pred = makePred({ pAbove: 0.3, pBelow: 0.3 });
    const signal: ExtremeSignal = { active: true, trigger: "price_vol_5m>10%" };
    const ctx = sm.advance(makeSnapshot(flatBars(30)), pred, makeInput(), signal);

    expect(ctx.state).toBe("EXTREME");
    expect(ctx.evalIntervalMs).toBe(60 * 1_000);   // 1 min
    expect(ctx.lendingPct).toBe(1.0);              // 100%
  });

  it("transitions from NORMAL to EXTREME via local p-sum > 0.7", () => {
    let t = 0;
    const sm = createStateMachine({ poolId: "poolE2", db, now: () => t });

    t = MIN_DWELL_MS.NORMAL + 1_000;
    const pred = makePred({ pAbove: 0.4, pBelow: 0.35 });  // sum 0.75
    const ctx = sm.advance(makeSnapshot(flatBars(30)), pred, makeInput());

    expect(ctx.state).toBe("EXTREME");
  });

  it("transitions from TREND to EXTREME via injected signal", () => {
    let t = 0;
    const sm = createStateMachine({ poolId: "poolE3", db, now: () => t });

    // First: advance to TREND (spike bars, p_break below 0.7 threshold)
    t = MIN_DWELL_MS.NORMAL + 1_000;
    const trendSnap = makeSnapshot(highDriftBars(20, 2.5, 0.0001, 0.03));
    sm.advance(trendSnap, makePred({ pAbove: 0.3, pBelow: 0.3 }), makeInput());
    expect(sm.current().state).toBe("TREND");

    // Then: advance to EXTREME via signal after TREND dwell
    t = t + MIN_DWELL_MS.TREND + 1_000;
    const signal: ExtremeSignal = { active: true, trigger: "tvl_drop" };
    const pred = makePred({ pAbove: 0.3, pBelow: 0.3 });
    const ctx = sm.advance(makeSnapshot(flatBars(30)), pred, makeInput(), signal);

    expect(ctx.state).toBe("EXTREME");
  });

  it("EXTREME state has evalIntervalMs = 1 min", () => {
    let t = 0;
    const sm = createStateMachine({ poolId: "poolE4", db, now: () => t });

    t = MIN_DWELL_MS.NORMAL + 1_000;
    const signal: ExtremeSignal = { active: true, trigger: "test" };
    const ctx = sm.advance(makeSnapshot(flatBars(30)), makePred(), makeInput(), signal);

    expect(ctx.evalIntervalMs).toBe(EVAL_INTERVAL_MS.EXTREME);
    expect(ctx.evalIntervalMs).toBe(60_000);
  });

  it("EXTREME state has lendingPct = 1.0", () => {
    let t = 0;
    const sm = createStateMachine({ poolId: "poolE5", db, now: () => t });

    t = MIN_DWELL_MS.NORMAL + 1_000;
    const signal: ExtremeSignal = { active: true, trigger: "test" };
    const ctx = sm.advance(makeSnapshot(flatBars(30)), makePred(), makeInput(), signal);

    expect(ctx.lendingPct).toBe(1.0);
  });
});

describe("StateMachine — EXTREME exit with dwell + hysteresis", () => {
  let db: Database;
  beforeEach(() => { db = openTestDb(); });
  afterEach(() => { db.close(); });

  it("does NOT exit EXTREME before min-dwell has elapsed", () => {
    let t = 0;
    const sm = createStateMachine({ poolId: "poolX1", db, now: () => t });

    // Enter EXTREME at t=15min+1
    t = MIN_DWELL_MS.NORMAL + 1_000;
    const entrySignal: ExtremeSignal = { active: true, trigger: "test" };
    sm.advance(makeSnapshot(flatBars(30)), makePred(), makeInput(), entrySignal);
    const extremeEntry = t;

    // Try to exit 5 min later (before 10-min dwell)
    t = extremeEntry + 5 * 60 * 1_000;
    const pred = makePred({ pAbove: 0.2, pBelow: 0.2 });
    const ctx = sm.advance(makeSnapshot(flatBars(30)), pred, makeInput(), null);

    expect(ctx.state).toBe("EXTREME");
  });

  it("exits EXTREME after dwell when all conditions clear (volRecovered=true from risk monitor)", () => {
    let t = 0;
    const sm = createStateMachine({ poolId: "poolX2", db, now: () => t });

    // Enter EXTREME
    t = MIN_DWELL_MS.NORMAL + 1_000;
    const entrySignal: ExtremeSignal = { active: true, trigger: "test" };
    sm.advance(makeSnapshot(flatBars(30)), makePred(), makeInput(), entrySignal);
    const extremeEntry = t;

    // Wait 10 min + 1s, no signal, low p-sum.
    // Pass volRecovered=true (which in production mlAgent gets from riskMonitor.volRecovered()).
    t = extremeEntry + MIN_DWELL_MS.EXTREME + 1_000;
    const pred = makePred({ pAbove: 0.2, pBelow: 0.2 });  // sum = 0.4
    const ctx = sm.advance(makeSnapshot(flatBars(30)), pred, makeInput(), null, true);

    expect(ctx.state).not.toBe("EXTREME");
    expect(ctx.state).toBe("NORMAL");
  });

  it("does NOT exit EXTREME while external signal is still active (even with volRecovered)", () => {
    let t = 0;
    const sm = createStateMachine({ poolId: "poolX3", db, now: () => t });

    t = MIN_DWELL_MS.NORMAL + 1_000;
    const entrySignal: ExtremeSignal = { active: true, trigger: "test" };
    sm.advance(makeSnapshot(flatBars(30)), makePred(), makeInput(), entrySignal);
    const extremeEntry = t;

    // After dwell, signal still active — should not exit even with volRecovered=true
    t = extremeEntry + MIN_DWELL_MS.EXTREME + 1_000;
    const pred = makePred({ pAbove: 0.2, pBelow: 0.2 });
    const keepSignal: ExtremeSignal = { active: true, trigger: "still_bad" };
    const ctx = sm.advance(makeSnapshot(flatBars(30)), pred, makeInput(), keepSignal, true);

    expect(ctx.state).toBe("EXTREME");
  });
});

describe("StateMachine — no flapping under oscillating input", () => {
  let db: Database;
  beforeEach(() => { db = openTestDb(); });
  afterEach(() => { db.close(); });

  it("does not flip state on every advance if min-dwell blocks it", () => {
    let t = 0;
    const sm = createStateMachine({ poolId: "poolFlap", db, now: () => t });

    // Enter TREND at t=dwell+1 (spike bars, safe p-sum)
    t = MIN_DWELL_MS.NORMAL + 1_000;
    const trendSnap = makeSnapshot(highDriftBars(20, 2.5, 0.0001, 0.03));
    sm.advance(trendSnap, makePred({ pAbove: 0.3, pBelow: 0.3 }), makeInput());

    // Now alternate between trend-triggering and non-triggering conditions
    // for several ticks, all within TREND min-dwell
    const trendEntry = t;
    for (let i = 1; i <= 5; i++) {
      t = trendEntry + i * 60_000;  // 1 min increments — all within 15-min dwell
      const flat = makeSnapshot(flatBars(30));
      const normalPred = makePred({ pAbove: 0.3, pBelow: 0.3 });
      const ctx = sm.advance(flat, normalPred, makeInput());
      // Still in TREND because dwell hasn't elapsed
      expect(ctx.state).toBe("TREND");
    }
  });

  it("does not transition from TREND to NORMAL and back within two ticks", () => {
    let t = 0;
    const sm = createStateMachine({ poolId: "poolFlap2", db, now: () => t });

    // Enter TREND (spike bars, safe p-sum)
    t = MIN_DWELL_MS.NORMAL + 1_000;
    const trendSnap = makeSnapshot(highDriftBars(20, 2.5, 0.0001, 0.03));
    sm.advance(trendSnap, makePred({ pAbove: 0.3, pBelow: 0.3 }), makeInput());
    const trendEntry = t;

    // Advance past TREND dwell → exit to NORMAL
    t = trendEntry + MIN_DWELL_MS.TREND + 1_000;
    const flat = makeSnapshot(flatBars(30));
    const normalPred = makePred({ pAbove: 0.3, pBelow: 0.3 });
    const ctx1 = sm.advance(flat, normalPred, makeInput());
    expect(ctx1.state).toBe("NORMAL");

    // Immediately try to go back to TREND: blocked by NORMAL min-dwell
    // Use safe p-sum (max > 0.6 but sum < 0.7) + spike bars
    t = t + 1_000;  // 1 second after entering NORMAL
    const trendSnap2 = makeSnapshot(highDriftBars(20, 2.5, 0.0001, 0.03));
    const trendPred = makePred({ pAbove: 0.65, pBelow: 0.04 });  // sum=0.69
    const ctx2 = sm.advance(trendSnap2, trendPred, makeInput());
    expect(ctx2.state).toBe("NORMAL");  // dwell still active
  });
});

describe("StateMachine — DB persistence: market_state_history rows", () => {
  let db: Database;
  beforeEach(() => { db = openTestDb(); });
  afterEach(() => { db.close(); });

  it("initial row has no exited_at_ms", () => {
    createStateMachine({ poolId: "pool-db1", db, now: () => 0 });
    const rows = getRows(db, "pool-db1");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.exited_at_ms).toBeNull();
  });

  it("transition sets exited_at_ms on previous row and inserts new row", () => {
    let t = 0;
    const sm = createStateMachine({ poolId: "pool-db2", db, now: () => t });

    t = MIN_DWELL_MS.NORMAL + 1_000;
    // Spike bars → drift >> 2.0; safe p-sum (sum < 0.7)
    const trendSnap = makeSnapshot(highDriftBars(20, 2.5, 0.0001, 0.03));
    sm.advance(trendSnap, makePred({ pAbove: 0.3, pBelow: 0.3 }), makeInput());

    const rows = getRows(db, "pool-db2");
    expect(rows).toHaveLength(2);

    // First row: NORMAL, exited at t
    expect(rows[0]!.state).toBe("NORMAL");
    expect(rows[0]!.exited_at_ms).toBe(t);

    // Second row: TREND, not yet exited
    expect(rows[1]!.state).toBe("TREND");
    expect(rows[1]!.exited_at_ms).toBeNull();
    expect(rows[1]!.prev_state).toBe("NORMAL");
  });

  it("exited_at_ms chaining: N→T→N produces correct timestamps", () => {
    let t = 0;
    const sm = createStateMachine({ poolId: "pool-db3", db, now: () => t });

    // NORMAL → TREND at t1 (spike bars, safe p-sum)
    const t1 = MIN_DWELL_MS.NORMAL + 1_000;
    t = t1;
    sm.advance(makeSnapshot(highDriftBars(20, 2.5, 0.0001, 0.03)), makePred({ pAbove: 0.3, pBelow: 0.3 }), makeInput());

    // TREND → NORMAL at t2 (flat, low p-break)
    const t2 = t1 + MIN_DWELL_MS.TREND + 1_000;
    t = t2;
    sm.advance(makeSnapshot(flatBars(30)), makePred({ pAbove: 0.3, pBelow: 0.3 }), makeInput());

    const rows = getRows(db, "pool-db3");
    expect(rows).toHaveLength(3);

    // NORMAL row: exited at t1
    expect(rows[0]!.state).toBe("NORMAL");
    expect(rows[0]!.exited_at_ms).toBe(t1);

    // TREND row: exited at t2
    expect(rows[1]!.state).toBe("TREND");
    expect(rows[1]!.exited_at_ms).toBe(t2);

    // NORMAL row: open
    expect(rows[2]!.state).toBe("NORMAL");
    expect(rows[2]!.exited_at_ms).toBeNull();
    expect(rows[2]!.prev_state).toBe("TREND");
  });

  it("trigger string is stored in DB row", () => {
    let t = 0;
    const sm = createStateMachine({ poolId: "pool-db4", db, now: () => t });

    t = MIN_DWELL_MS.NORMAL + 1_000;
    const signal: ExtremeSignal = { active: true, trigger: "price_spike_test" };
    sm.advance(makeSnapshot(flatBars(30)), makePred(), makeInput(), signal);

    const rows = getRows(db, "pool-db4");
    expect(rows).toHaveLength(2);
    expect(rows[1]!.trigger).toBe("price_spike_test");
  });

  it("multiple pools produce independent history rows", () => {
    let t = 0;
    const smA = createStateMachine({ poolId: "poolA", db, now: () => t });
    const smB = createStateMachine({ poolId: "poolB", db, now: () => t });

    t = MIN_DWELL_MS.NORMAL + 1_000;
    // Pool A: spike bars + safe p-sum → TREND
    smA.advance(makeSnapshot(highDriftBars(20, 2.5, 0.0001, 0.03)), makePred({ pAbove: 0.3, pBelow: 0.3 }), makeInput());

    const rowsA = getRows(db, "poolA");
    const rowsB = getRows(db, "poolB");

    // Pool A transitioned to TREND
    expect(rowsA[rowsA.length - 1]!.state).toBe("TREND");
    // Pool B is still NORMAL
    expect(rowsB[rowsB.length - 1]!.state).toBe("NORMAL");
  });
});

describe("StateMachine — StateContext fields", () => {
  let db: Database;
  beforeEach(() => { db = openTestDb(); });
  afterEach(() => { db.close(); });

  it("NORMAL: lendingPct=0.35, evalIntervalMs=20min, minDwellMs=15min", () => {
    const sm = createStateMachine({ poolId: "pool-ctx1", db, now: () => 0 });
    const ctx = sm.advance(
      makeSnapshot(flatBars(30)),
      makePred({ pAbove: 0.3, pBelow: 0.3, widthSigma: 2.0 }),
      makeInput(),
    );
    expect(ctx.state).toBe("NORMAL");
    expect(ctx.lendingPct).toBeCloseTo(0.35, 10);
    expect(ctx.evalIntervalMs).toBe(20 * 60 * 1_000);
    expect(ctx.minDwellMs).toBe(15 * 60 * 1_000);
    expect(ctx.trendBias).toBe(0);  // non-TREND state
  });

  it("EXTREME: evalIntervalMs=1min, lendingPct=1.0, minDwellMs=10min", () => {
    let t = 0;
    const sm = createStateMachine({ poolId: "pool-ctx2", db, now: () => t });

    t = MIN_DWELL_MS.NORMAL + 1_000;
    const signal: ExtremeSignal = { active: true, trigger: "test" };
    const ctx = sm.advance(makeSnapshot(flatBars(30)), makePred(), makeInput(), signal);

    expect(ctx.state).toBe("EXTREME");
    expect(ctx.evalIntervalMs).toBe(60_000);
    expect(ctx.lendingPct).toBe(1.0);
    expect(ctx.minDwellMs).toBe(10 * 60 * 1_000);
  });

  it("halfWidth is derived from widthSigma", () => {
    const sm = createStateMachine({ poolId: "pool-ctx3", db, now: () => 0 });
    const ctx = sm.advance(
      makeSnapshot(flatBars(30)),
      makePred({ widthSigma: 2.0 }),  // → round(2.0×2)=4
      makeInput(),
    );
    expect(ctx.halfWidth).toBe(4);
  });

  it("toleranceBins is derived from widthSigma, capped at halfWidth (F4)", () => {
    const sm = createStateMachine({ poolId: "pool-ctx4", db, now: () => 0 });
    const ctx = sm.advance(
      makeSnapshot(flatBars(30)),
      makePred({ widthSigma: 2.0 }),  // → max(1, round(2.0))=2, halfWidth=4 → no cap
      makeInput(),
    );
    expect(ctx.toleranceBins).toBe(2);
    expect(ctx.toleranceBins).toBeLessThanOrEqual(ctx.halfWidth);
  });

  // "maxCenterOffset is populated in StateContext (F5)" and "maxCenterOffset=1 when
  // uncertainty is high" removed with the center prediction head (docs/decision-remove-center-prediction.md)

  it("TREND: trendBias is computed from pAbove-pBelow", () => {
    let t = 0;
    const sm = createStateMachine({ poolId: "pool-ctx5", db, now: () => t });

    t = MIN_DWELL_MS.NORMAL + 1_000;
    // pAbove=0.65, pBelow=0.04: max=0.65>0.6 (TREND entry), sum=0.69<0.7 (no EXTREME)
    // trendBias = clamp((0.65-0.04)/0.5, -1, 1) = clamp(1.22, -1, 1) = 1.0
    const pred = makePred({ pAbove: 0.65, pBelow: 0.04 });
    const ctx = sm.advance(makeSnapshot(flatBars(30)), pred, makeInput());

    expect(ctx.state).toBe("TREND");
    expect(ctx.trendBias).toBeCloseTo(1.0, 10);
  });
});

// ---------------------------------------------------------------------------
// Phase 1 additions — EXTREME dwell bypass, exit hysteresis, NaN guards,
// injectable StateParams, current() caching.
// ---------------------------------------------------------------------------

describe("machine.ts — EXTREME entry bypasses min-dwell (emergency escalation)", () => {
  let db: Database;
  beforeEach(() => { db = openTestDb(); });
  afterEach(() => { db.close(); });

  it("L2 extremeSignal 1 min after boot (NORMAL dwell NOT elapsed) → EXTREME", () => {
    let t = 0;
    const sm = createStateMachine({ poolId: "bypass1", db, now: () => t });
    t = 60_000; // 1 min — far below the 15-min NORMAL dwell
    const signal: ExtremeSignal = { active: true, trigger: "vol_5m>0.10" };
    const ctx = sm.advance(makeSnapshot(flatBars(30)), makePred(), makeInput(), signal);
    expect(ctx.state).toBe("EXTREME");
    const rows = getRows(db, "bypass1");
    expect(rows[rows.length - 1]!.state).toBe("EXTREME");
    expect(rows[rows.length - 1]!.trigger).toBe("vol_5m>0.10");
  });

  it("local p-sum spike 1 min after boot → EXTREME", () => {
    let t = 0;
    const sm = createStateMachine({ poolId: "bypass2", db, now: () => t });
    t = 60_000;
    const pred = makePred({ pAbove: 0.5, pBelow: 0.4 }); // sum 0.9 > 0.7
    const ctx = sm.advance(makeSnapshot(flatBars(30)), pred, makeInput());
    expect(ctx.state).toBe("EXTREME");
  });

  it("L2 signal 1 min after entering TREND (TREND dwell NOT elapsed) → EXTREME", () => {
    let t = 0;
    const sm = createStateMachine({ poolId: "bypass3", db, now: () => t });
    // Enter TREND via p_break (after the NORMAL dwell elapses)
    t = MIN_DWELL_MS.NORMAL + 1_000;
    sm.advance(makeSnapshot(flatBars(30)), makePred({ pAbove: 0.65, pBelow: 0.04 }), makeInput());
    expect(sm.current().state).toBe("TREND");
    // 1 minute later, L2 fires — must escalate despite TREND's 15-min dwell.
    t += 60_000;
    const signal: ExtremeSignal = { active: true, trigger: "spread_sustained" };
    const ctx = sm.advance(makeSnapshot(flatBars(30)), makePred(), makeInput(), signal);
    expect(ctx.state).toBe("EXTREME");
  });

  it("regression: NORMAL→TREND is still blocked before the NORMAL dwell elapses", () => {
    let t = 0;
    const sm = createStateMachine({ poolId: "bypass4", db, now: () => t });
    t = 60_000;
    // p_break entry condition satisfied but sum < 0.7 (no EXTREME)
    const pred = makePred({ pAbove: 0.65, pBelow: 0.04 });
    const ctx = sm.advance(makeSnapshot(flatBars(30)), pred, makeInput());
    expect(ctx.state).toBe("NORMAL"); // dwell blocks the non-emergency transition
  });

  it("regression: EXTREME exit is still blocked before the EXTREME dwell elapses", () => {
    let t = 0;
    const sm = createStateMachine({ poolId: "bypass5", db, now: () => t });
    t = 60_000;
    sm.advance(makeSnapshot(flatBars(30)), makePred(), makeInput(), { active: true, trigger: "x" });
    expect(sm.current().state).toBe("EXTREME");
    // 5 minutes later: signal cleared, vol recovered — but dwell (10 min) not elapsed.
    t += 5 * 60_000;
    const ctx = sm.advance(makeSnapshot(flatBars(30)), makePred({ pAbove: 0.1, pBelow: 0.1 }), makeInput(), null, true);
    expect(ctx.state).toBe("EXTREME");
  });
});

describe("shouldExitExtreme — p-sum exit hysteresis band", () => {
  const entered = 0;
  const now = 11 * 60_000; // stability window elapsed

  it("pSum in the hysteresis band (0.6 < 0.65 ≤ 0.7) blocks exit", () => {
    const pred = makePred({ pAbove: 0.35, pBelow: 0.30 }); // 0.65
    expect(shouldExitExtreme(pred, null, true, entered, now)).toBe(false);
  });

  it("pSum below the exit threshold (0.55 < 0.6) allows exit", () => {
    const pred = makePred({ pAbove: 0.30, pBelow: 0.25 }); // 0.55
    expect(shouldExitExtreme(pred, null, true, entered, now)).toBe(true);
  });
});

describe("params.ts / transitions.ts — non-finite input guards (fail loud)", () => {
  it("deriveHalfWidth(NaN) throws", () => {
    expect(() => deriveHalfWidth(NaN)).toThrow(RangeError);
  });

  it("deriveHalfWidth(Infinity) throws", () => {
    expect(() => deriveHalfWidth(Infinity)).toThrow(RangeError);
  });

  it("deriveToleranceBins(NaN, 4) throws", () => {
    expect(() => deriveToleranceBins(NaN, 4)).toThrow(RangeError);
  });

  // "deriveMaxCenterOffset(NaN, false) throws" removed with the center prediction head (docs/decision-remove-center-prediction.md)

  it("deriveTrendBias(NaN, 0.3) throws", () => {
    expect(() => deriveTrendBias(NaN, 0.3)).toThrow(RangeError);
  });

  it("deriveLendingPct('TREND', NaN) throws", () => {
    expect(() => deriveLendingPct("TREND", NaN)).toThrow(RangeError);
  });

  it("computeDriftStrength throws on a NaN close mid-series", () => {
    const bars = flatBars(30);
    bars[15] = { ...bars[15]!, close: NaN };
    expect(() => computeDriftStrength(makeSnapshot(bars))).toThrow(RangeError);
  });
});

describe("machine.ts — injectable StateParams + current() caching", () => {
  let db: Database;
  beforeEach(() => { db = openTestDb(); });
  afterEach(() => { db.close(); });

  it("honours an injected pBreakEntry override for TREND entry", () => {
    let t = 0;
    const sm = createStateMachine({
      poolId: "params1",
      db,
      now: () => t,
      params: { ...DEFAULT_STATE_PARAMS, pBreakEntry: 0.5 },
    });
    t = MIN_DWELL_MS.NORMAL + 1_000;
    // pAbove=0.55 would NOT trigger with the default 0.6 threshold.
    const ctx = sm.advance(makeSnapshot(flatBars(30)), makePred({ pAbove: 0.55, pBelow: 0.1 }), makeInput());
    expect(ctx.state).toBe("TREND");
  });

  it("honours an injected pBreakSumExtreme override for EXTREME entry", () => {
    let t = 60_000;
    const sm = createStateMachine({
      poolId: "params2",
      db,
      now: () => t,
      params: { ...DEFAULT_STATE_PARAMS, pBreakSumExtreme: 0.5, pBreakSumExtremeExit: 0.4 },
    });
    // sum=0.6 — below the default 0.7, above the injected 0.5.
    const ctx = sm.advance(makeSnapshot(flatBars(30)), makePred({ pAbove: 0.3, pBelow: 0.3 }), makeInput());
    expect(ctx.state).toBe("EXTREME");
  });

  it("current() reflects the advance()-derived TREND lendingPct ramp (C4)", () => {
    let t = 0;
    const sm = createStateMachine({ poolId: "params3", db, now: () => t });
    t = MIN_DWELL_MS.NORMAL + 1_000;
    // trendBias = clamp((0.65-0.04)/0.5) = 1.0 → lendingPct = 0.5 + 0.2×1 = 0.70
    const ctx = sm.advance(makeSnapshot(flatBars(30)), makePred({ pAbove: 0.65, pBelow: 0.04 }), makeInput());
    expect(ctx.state).toBe("TREND");
    expect(ctx.lendingPct).toBeCloseTo(0.70, 10);
    // Pre-fix, current() returned the hardcoded 0.50 — the ramp never reached
    // the lending router. Now it returns the cached advance() context.
    expect(sm.current().lendingPct).toBeCloseTo(0.70, 10);
    expect(sm.current().strongTrend).toBe(true);
  });

  it("strongTrend derives from the injected trendBiasStrong threshold", () => {
    let t = 0;
    const sm = createStateMachine({
      poolId: "params4",
      db,
      now: () => t,
      params: { ...DEFAULT_STATE_PARAMS, trendBiasStrong: 0.99 },
    });
    t = MIN_DWELL_MS.NORMAL + 1_000;
    // Enter TREND via drift strength (p stays below all p-break thresholds);
    // trendBias = clamp((0.50-0.08)/0.5)=0.84 — strong under the default 0.7,
    // weak under the injected 0.99.
    const driftSnap = makeSnapshot(highDriftBars(26, 2.5, 0.0002, 0.02));
    const ctx = sm.advance(driftSnap, makePred({ pAbove: 0.50, pBelow: 0.08 }), makeInput());
    expect(ctx.state).toBe("TREND");
    expect(ctx.trendBias).toBeCloseTo(0.84, 10);
    expect(ctx.strongTrend).toBe(false);
  });
});
