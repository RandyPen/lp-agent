/**
 * tests/risk/monitor.test.ts
 *
 * Integration-level tests for src/risk/monitor.ts.
 * Uses a temp-file SQLite DB (same pattern as tests/treasury/store.test.ts).
 * All tests are deterministic via injected clock.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, resetDbCacheForTests } from "../../src/db/client.ts";
import { createRiskMonitor } from "../../src/risk/monitor.ts";
import { createEmergencyStop } from "../../src/risk/emergency.ts";
import type { RiskThresholds } from "../../src/config.ts";
import type { MarketSnapshot, PredictionResponse } from "../../src/prediction/types.ts";
import type { StrategyInput } from "../../src/strategies/types.ts";
import { emptyLendingState } from "../../src/sui/lending/types.ts";
import type { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let db: Database;

function freshDb(): Database {
  resetDbCacheForTests();
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDir = mkdtempSync(join(tmpdir(), "risk-monitor-"));
  return openDb(join(tmpDir, "test.db"));
}

afterAll(() => {
  resetDbCacheForTests();
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const POOL_ID = "0xpool";
const PM_ID = "0xpm";

const DEFAULT_THRESHOLDS: RiskThresholds = {
  extremeVolatility5m: 0.10,
  tvlDrop5m: 0.50,
  spreadExtreme: 0.05,
  spreadSustainMs: 30_000,
  pBreakSum: 0.70,
  pnl24hPct: -0.05,
  l1SpreadSoftBandLow: 0.005,
  l1SpreadSoftBandHigh: 0.01,
};

const BASE_NOW = 1_700_000_000_000;

function makeSnapshot(
  overrides: {
    ts?: number;
    price?: string;
    tvlUsd?: number;
    activeBin?: number;
    spread?: number;
  } = {},
): MarketSnapshot {
  return {
    ts: overrides.ts ?? BASE_NOW,
    cetus: {
      activeBin: overrides.activeBin ?? 100,
      price: overrides.price ?? "1.0000",
      tvlUsd: overrides.tvlUsd ?? 1_000_000,
      binStep: 10,
    },
    binance: { sui: [], btc: [], eth: [] },
    derivatives: { funding: 0, oi: 0, liq1m: 0 },
    spread: overrides.spread ?? 0.001,
  };
}

function makePrediction(overrides: Partial<PredictionResponse> = {}): PredictionResponse {
  return {
    centerOffset: 0,
    centerQ10: -1,
    centerQ90: 1,
    widthSigma: 0.78,
    pAbove: 0.15,
    pBelow: 0.15,
    modelVersion: "null-v0",
    featureCompleteness: 1.0,
    psi: 0.01,
    fallback: false,
    ...overrides,
  };
}

function makeStrategyInput(): StrategyInput {
  return {
    pm: {
      pmId: PM_ID,
      owner: "0xowner",
      poolId: POOL_ID,
      coinTypeA: "0x...::sui::SUI",
      coinTypeB: "0x...::usdc::USDC",
      balance: { a: 0n, b: 0n },
      feeBag: { a: 0n, b: 0n },
      positionBins: [],
      lending: emptyLendingState(),
    },
    pool: {
      poolId: POOL_ID,
      activeBinId: 100,
      binStep: 10,
      feeRateBps: 40,
    },
    spot: { price: "1.0000", timestampMs: BASE_NOW, source: "test" },
    history: [],
    profile: {
      name: "sui-usdc",
      network: "mainnet",
      poolId: POOL_ID,
      binStep: 10,
      coinTypeA: "0x...::sui::SUI",
      coinTypeB: "0x...::usdc::USDC",
      decimalsA: 9,
      decimalsB: 6,
      pricePairLabel: "SUI/USDC",
      defaultStrategyParams: { binWidth: 10, expectedFeeBps: 40 },
      lendingPolicy: {},
    },
  };
}

function countRiskEvents(database: Database): number {
  const result = database.prepare<{ n: number }, []>("SELECT COUNT(*) as n FROM risk_events").get();
  return result?.n ?? 0;
}

function getRiskEvents(database: Database): Array<{
  level: string;
  kind: string;
  metric: string;
  pool_id: string | null;
  pm_id: string | null;
}> {
  return database
    .prepare<{ level: string; kind: string; metric: string; pool_id: string | null; pm_id: string | null }, []>(
      "SELECT level, kind, metric, pool_id, pm_id FROM risk_events ORDER BY id",
    )
    .all();
}

// ---------------------------------------------------------------------------
// Tests: L3 emergency stop takes precedence
// ---------------------------------------------------------------------------

describe("L3 emergency stop veto", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("checkPreTick returns L3 veto when emergency stop is tripped", () => {
    const emergencyStop = createEmergencyStop({ db });
    const monitor = createRiskMonitor({ db, thresholds: DEFAULT_THRESHOLDS, emergencyStop });

    emergencyStop.trip("manual test");
    const veto = monitor.checkPreTick(makeStrategyInput());
    expect(veto).not.toBeNull();
    expect(veto!.level).toBe("L3");
    expect(veto!.kind).toBe("emergency");
  });

  it("activeLevel returns L3 when emergency stop is tripped", () => {
    const emergencyStop = createEmergencyStop({ db });
    const monitor = createRiskMonitor({ db, thresholds: DEFAULT_THRESHOLDS, emergencyStop });

    emergencyStop.trip("test");
    expect(monitor.activeLevel(POOL_ID)).toBe("L3");
  });

  it("checkPreTick returns null after emergency reset", () => {
    const emergencyStop = createEmergencyStop({ db });
    const monitor = createRiskMonitor({ db, thresholds: DEFAULT_THRESHOLDS, emergencyStop });

    emergencyStop.trip("test");
    emergencyStop.reset("acknowledged");
    const veto = monitor.checkPreTick(makeStrategyInput());
    expect(veto).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: L1 soft band
// ---------------------------------------------------------------------------

describe("L1 soft circuit band", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("returns L1 soft veto when spread is within soft band [0.005, 0.01)", () => {
    let clock = BASE_NOW;
    const monitor = createRiskMonitor({
      db,
      thresholds: DEFAULT_THRESHOLDS,
      nowMs: () => clock,
    });
    const extMonitor = monitor as any; // access observeForPool

    // Observe snapshot with spread in the soft band
    extMonitor.observeForPool(POOL_ID, makeSnapshot({ spread: 0.007, ts: clock }));

    const veto = monitor.checkPreTick(makeStrategyInput());
    expect(veto).not.toBeNull();
    expect(veto!.level).toBe("L1");
    expect(veto!.kind).toBe("soft");
    expect((veto as any).lendingPctBonusPp).toBe(10);
    expect((veto as any).halfWidthFactor).toBeCloseTo(0.7);
  });

  it("no veto when spread is below soft band lower bound", () => {
    let clock = BASE_NOW;
    const monitor = createRiskMonitor({
      db,
      thresholds: DEFAULT_THRESHOLDS,
      nowMs: () => clock,
    });
    const extMonitor = monitor as any;

    extMonitor.observeForPool(POOL_ID, makeSnapshot({ spread: 0.002, ts: clock })); // below 0.005
    const veto = monitor.checkPreTick(makeStrategyInput());
    expect(veto).toBeNull();
  });

  it("no L1 veto when spread is at or above l1SpreadSoftBandHigh (L2 territory)", () => {
    let clock = BASE_NOW;
    const monitor = createRiskMonitor({
      db,
      thresholds: DEFAULT_THRESHOLDS,
      nowMs: () => clock,
    });
    const extMonitor = monitor as any;

    // 0.01 = l1SpreadSoftBandHigh → should not be in soft band
    extMonitor.observeForPool(POOL_ID, makeSnapshot({ spread: 0.01, ts: clock }));
    const veto = monitor.checkPreTick(makeStrategyInput());
    // At 0.01 it's not in [low, high) — no L1 soft veto
    expect(veto?.level !== "L1" || veto === null).toBe(true);
  });

  it("L1 soft circuit persists a risk_events row", () => {
    const clock = BASE_NOW;
    const monitor = createRiskMonitor({
      db,
      thresholds: DEFAULT_THRESHOLDS,
      nowMs: () => clock,
    });
    const extMonitor = monitor as any;

    extMonitor.observeForPool(POOL_ID, makeSnapshot({ spread: 0.007, ts: clock }));
    expect(countRiskEvents(db)).toBeGreaterThan(0);

    const events = getRiskEvents(db);
    const l1Event = events.find((e) => e.level === "L1");
    expect(l1Event).toBeDefined();
    expect(l1Event?.kind).toBe("soft_enter");
  });

  it("activeLevel returns L1 when soft circuit is active", () => {
    const clock = BASE_NOW;
    const monitor = createRiskMonitor({
      db,
      thresholds: DEFAULT_THRESHOLDS,
      nowMs: () => clock,
    });
    const extMonitor = monitor as any;

    extMonitor.observeForPool(POOL_ID, makeSnapshot({ spread: 0.007, ts: clock }));
    expect(monitor.activeLevel(POOL_ID)).toBe("L1");
  });
});

// ---------------------------------------------------------------------------
// Tests: L2 EXTREME — individual trigger conditions
// ---------------------------------------------------------------------------

describe("L2 EXTREME: volatility trigger", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("fires when 5m price volatility exceeds threshold", () => {
    let clock = BASE_NOW;
    const monitor = createRiskMonitor({
      db,
      thresholds: DEFAULT_THRESHOLDS,
      nowMs: () => clock,
    });
    const extMonitor = monitor as any;

    // Price at t=0
    extMonitor.observeForPool(POOL_ID, makeSnapshot({ price: "1.0000", ts: clock }));
    // Price at t+3min — 15% move
    clock += 3 * 60 * 1000;
    extMonitor.observeForPool(POOL_ID, makeSnapshot({ price: "1.1500", ts: clock }));

    expect(monitor.activeLevel(POOL_ID)).toBe("L2");
    const events = getRiskEvents(db);
    const l2Event = events.find((e) => e.level === "L2" && e.kind === "extreme_enter");
    expect(l2Event).toBeDefined();
    expect(l2Event?.metric).toBe("volatility_5m");
  });

  it("does not fire when volatility is below threshold", () => {
    let clock = BASE_NOW;
    const monitor = createRiskMonitor({
      db,
      thresholds: DEFAULT_THRESHOLDS,
      nowMs: () => clock,
    });
    const extMonitor = monitor as any;

    extMonitor.observeForPool(POOL_ID, makeSnapshot({ price: "1.0000", ts: clock }));
    clock += 3 * 60 * 1000;
    extMonitor.observeForPool(POOL_ID, makeSnapshot({ price: "1.0500", ts: clock })); // 5% < 10%

    expect(monitor.activeLevel(POOL_ID)).toBeNull();
  });
});

describe("L2 EXTREME: TVL drop trigger", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("fires when TVL drops more than 50% in 5 minutes", () => {
    let clock = BASE_NOW;
    const monitor = createRiskMonitor({
      db,
      thresholds: DEFAULT_THRESHOLDS,
      nowMs: () => clock,
    });
    const extMonitor = monitor as any;

    extMonitor.observeForPool(POOL_ID, makeSnapshot({ tvlUsd: 1_000_000, ts: clock }));
    clock += 3 * 60 * 1000;
    extMonitor.observeForPool(POOL_ID, makeSnapshot({ tvlUsd: 400_000, ts: clock })); // 60% drop

    expect(monitor.activeLevel(POOL_ID)).toBe("L2");
  });

  it("does not fire when TVL drop is below threshold", () => {
    let clock = BASE_NOW;
    const monitor = createRiskMonitor({
      db,
      thresholds: DEFAULT_THRESHOLDS,
      nowMs: () => clock,
    });
    const extMonitor = monitor as any;

    extMonitor.observeForPool(POOL_ID, makeSnapshot({ tvlUsd: 1_000_000, ts: clock }));
    clock += 3 * 60 * 1000;
    extMonitor.observeForPool(POOL_ID, makeSnapshot({ tvlUsd: 700_000, ts: clock })); // 30% < 50%

    expect(monitor.activeLevel(POOL_ID)).toBeNull();
  });
});

describe("L2 EXTREME: spread sustained trigger", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("fires when spread exceeds 5% for 30+ seconds", () => {
    let clock = BASE_NOW;
    const monitor = createRiskMonitor({
      db,
      thresholds: DEFAULT_THRESHOLDS,
      nowMs: () => clock,
    });
    const extMonitor = monitor as any;

    // Spread high for 40s (> sustainMs=30s)
    extMonitor.observeForPool(POOL_ID, makeSnapshot({ spread: 0.06, ts: clock - 40_000 }));
    extMonitor.observeForPool(POOL_ID, makeSnapshot({ spread: 0.07, ts: clock - 20_000 }));
    extMonitor.observeForPool(POOL_ID, makeSnapshot({ spread: 0.06, ts: clock }));

    expect(monitor.activeLevel(POOL_ID)).toBe("L2");
  });

  it("does not fire when spread just exceeded threshold (< 30s)", () => {
    let clock = BASE_NOW;
    const monitor = createRiskMonitor({
      db,
      thresholds: DEFAULT_THRESHOLDS,
      nowMs: () => clock,
    });
    const extMonitor = monitor as any;

    extMonitor.observeForPool(POOL_ID, makeSnapshot({ spread: 0.02, ts: clock - 40_000 })); // below threshold
    extMonitor.observeForPool(POOL_ID, makeSnapshot({ spread: 0.06, ts: clock - 20_000 })); // just started
    extMonitor.observeForPool(POOL_ID, makeSnapshot({ spread: 0.06, ts: clock }));

    expect(monitor.activeLevel(POOL_ID)).toBeNull();
  });
});

describe("L2 EXTREME: pBreakSum trigger via prediction", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("fires when pAbove + pBelow > 0.70", () => {
    let clock = BASE_NOW;
    const monitor = createRiskMonitor({
      db,
      thresholds: DEFAULT_THRESHOLDS,
      nowMs: () => clock,
    });
    const extMonitor = monitor as any;

    const pred = makePrediction({ pAbove: 0.4, pBelow: 0.4 }); // sum = 0.80 > 0.70
    extMonitor.observeForPool(POOL_ID, makeSnapshot({ ts: clock }), pred);

    expect(monitor.activeLevel(POOL_ID)).toBe("L2");
    const events = getRiskEvents(db);
    const l2Event = events.find((e) => e.level === "L2" && e.kind === "extreme_enter");
    expect(l2Event?.metric).toBe("p_break_sum");
  });

  it("does not fire when pAbove + pBelow is at threshold (not strictly greater)", () => {
    const clock = BASE_NOW;
    const monitor = createRiskMonitor({
      db,
      thresholds: DEFAULT_THRESHOLDS,
      nowMs: () => clock,
    });
    const extMonitor = monitor as any;

    const pred = makePrediction({ pAbove: 0.35, pBelow: 0.35 }); // sum = 0.70 = threshold
    extMonitor.observeForPool(POOL_ID, makeSnapshot({ ts: clock }), pred);

    expect(monitor.activeLevel(POOL_ID)).toBeNull();
  });
});

describe("L2 EXTREME: 24h PnL trigger", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("fires when 24h PnL drops below threshold", () => {
    const clock = BASE_NOW;
    const monitor = createRiskMonitor({
      db,
      thresholds: DEFAULT_THRESHOLDS,
      nowMs: () => clock,
    });
    const extMonitor = monitor as any;

    extMonitor.set24hPnl(POOL_ID, -0.06); // below -0.05 threshold
    extMonitor.observeForPool(POOL_ID, makeSnapshot({ ts: clock }));

    expect(monitor.activeLevel(POOL_ID)).toBe("L2");
  });

  it("does not fire when 24h PnL is above threshold", () => {
    const clock = BASE_NOW;
    const monitor = createRiskMonitor({
      db,
      thresholds: DEFAULT_THRESHOLDS,
      nowMs: () => clock,
    });
    const extMonitor = monitor as any;

    extMonitor.set24hPnl(POOL_ID, -0.02);
    extMonitor.observeForPool(POOL_ID, makeSnapshot({ ts: clock }));

    expect(monitor.activeLevel(POOL_ID)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: risk_events DB writes
// ---------------------------------------------------------------------------

describe("risk_events persistence", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("L2 trigger writes risk_events row with correct pool_id", () => {
    const clock = BASE_NOW;
    const monitor = createRiskMonitor({
      db,
      thresholds: DEFAULT_THRESHOLDS,
      nowMs: () => clock,
    });
    const extMonitor = monitor as any;

    const pred = makePrediction({ pAbove: 0.45, pBelow: 0.45 });
    extMonitor.observeForPool(POOL_ID, makeSnapshot({ ts: clock }), pred);

    const events = getRiskEvents(db);
    const l2 = events.find((e) => e.level === "L2");
    expect(l2).toBeDefined();
    expect(l2?.pool_id).toBe(POOL_ID);
  });

  it("pre-tick veto for L2 writes a pre_tick_veto event", () => {
    const clock = BASE_NOW;
    const monitor = createRiskMonitor({
      db,
      thresholds: DEFAULT_THRESHOLDS,
      nowMs: () => clock,
    });
    const extMonitor = monitor as any;

    // Trigger L2
    const pred = makePrediction({ pAbove: 0.45, pBelow: 0.45 });
    extMonitor.observeForPool(POOL_ID, makeSnapshot({ ts: clock }), pred);

    // Now check pre-tick
    const before = countRiskEvents(db);
    monitor.checkPreTick(makeStrategyInput());
    const after = countRiskEvents(db);
    expect(after).toBeGreaterThan(before);

    const events = getRiskEvents(db);
    const preTickEvent = events.find((e) => e.kind === "pre_tick_veto");
    expect(preTickEvent).toBeDefined();
    expect(preTickEvent?.pm_id).toBe(PM_ID);
  });

  it("L1 soft enter writes risk_events row", () => {
    const clock = BASE_NOW;
    const monitor = createRiskMonitor({
      db,
      thresholds: DEFAULT_THRESHOLDS,
      nowMs: () => clock,
    });
    const extMonitor = monitor as any;

    extMonitor.observeForPool(POOL_ID, makeSnapshot({ spread: 0.007, ts: clock }));

    const events = getRiskEvents(db);
    const l1 = events.find((e) => e.level === "L1");
    expect(l1).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: EXTREME exit hysteresis (no flapping)
// ---------------------------------------------------------------------------

describe("EXTREME exit hysteresis", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("stays in EXTREME during the 10-minute stable period even when triggers clear", () => {
    let clock = BASE_NOW;
    const monitor = createRiskMonitor({
      db,
      thresholds: DEFAULT_THRESHOLDS,
      nowMs: () => clock,
    });
    const extMonitor = monitor as any;

    // Enter EXTREME via volatility
    extMonitor.observeForPool(POOL_ID, makeSnapshot({ price: "1.0000", ts: clock }));
    clock += 3 * 60 * 1000;
    extMonitor.observeForPool(POOL_ID, makeSnapshot({ price: "1.15", ts: clock })); // 15% vol

    expect(monitor.activeLevel(POOL_ID)).toBe("L2");

    // Now prices settle — BUT only 5 minutes have passed, not 10
    clock += 5 * 60 * 1000;
    extMonitor.observeForPool(POOL_ID, makeSnapshot({ price: "1.15", ts: clock })); // stable, low vol now

    // Still in EXTREME (only 8 min total, stable period is 10m)
    expect(monitor.activeLevel(POOL_ID)).toBe("L2");
  });

  it("exits EXTREME after stable period + volatility recovery", () => {
    let clock = BASE_NOW;
    const monitor = createRiskMonitor({
      db,
      thresholds: DEFAULT_THRESHOLDS,
      nowMs: () => clock,
    });
    const extMonitor = monitor as any;

    // Enter EXTREME at clock=0
    extMonitor.observeForPool(POOL_ID, makeSnapshot({ price: "1.0000", ts: clock }));
    clock += 3 * 60 * 1000;
    extMonitor.observeForPool(POOL_ID, makeSnapshot({ price: "1.15", ts: clock })); // +15% → enters EXTREME

    expect(monitor.activeLevel(POOL_ID)).toBe("L2");

    // Jump forward 12 minutes — prices now stable and low vol
    clock += 12 * 60 * 1000;
    // Add a recent stable price (close to 1.15, no big move)
    extMonitor.observeForPool(POOL_ID, makeSnapshot({ price: "1.16", ts: clock - 4 * 60 * 1000 }));
    extMonitor.observeForPool(POOL_ID, makeSnapshot({ price: "1.16", ts: clock - 2 * 60 * 1000 }));
    extMonitor.observeForPool(POOL_ID, makeSnapshot({ price: "1.165", ts: clock })); // tiny vol, well below 7%

    // After 12+ minutes with stable prices, should exit EXTREME
    expect(monitor.activeLevel(POOL_ID)).toBeNull();

    const events = getRiskEvents(db);
    const exitEvent = events.find((e) => e.kind === "extreme_exit");
    expect(exitEvent).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: activeLevel returns null when no circuit is active
// ---------------------------------------------------------------------------

describe("activeLevel when no circuits active", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("returns null for an unknown poolId", () => {
    const monitor = createRiskMonitor({ db, thresholds: DEFAULT_THRESHOLDS });
    expect(monitor.activeLevel("0xunknown")).toBeNull();
  });

  it("returns null after normal observation with healthy data", () => {
    const clock = BASE_NOW;
    const monitor = createRiskMonitor({
      db,
      thresholds: DEFAULT_THRESHOLDS,
      nowMs: () => clock,
    });
    const extMonitor = monitor as any;

    extMonitor.observeForPool(POOL_ID, makeSnapshot({ ts: clock }));
    expect(monitor.activeLevel(POOL_ID)).toBeNull();
  });
});
