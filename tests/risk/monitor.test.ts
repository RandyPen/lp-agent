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
  volatilityRecovery: 0.07,
  sourceStaleSuiMs: 60_000,
  sourceStaleCetusMs: 180_000,
  sourceStaleDerivMs: 600_000,
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

// ---------------------------------------------------------------------------
// Phase 1 additions — L3 auto-trip, per-source staleness, configurable
// volatility recovery.
// ---------------------------------------------------------------------------

import type { L3Thresholds } from "../../src/config.ts";
import type { StalenessInfo } from "../../src/data/marketAggregator.ts";

const TEST_L3: L3Thresholds = {
  repeatedL2Count: 3,
  repeatedL2WindowMs: 3_600_000,
  outageMs: 300_000,
  pnlPct: -0.15,
  txFailureCount: 5,
};

function makeStaleness(overrides: Partial<StalenessInfo> = {}): StalenessInfo {
  return { sui: 0, btc: 0, eth: 0, derivatives: 0, cetus: 0, ...overrides };
}

function makeInputWithPosition(): StrategyInput {
  const input = makeStrategyInput();
  input.pm.positionBins = [
    { binId: 99, liquidityShare: 1_000n, amountA: 0n, amountB: 0n },
    { binId: 101, liquidityShare: 1_000n, amountA: 0n, amountB: 0n },
  ];
  return input;
}

describe("L3 auto-trip: repeated L2 activations", () => {
  beforeEach(() => { db = freshDb(); });

  it("trips after N EXTREME entries within the window", () => {
    let now = BASE_NOW;
    const monitor = createRiskMonitor({
      db, thresholds: DEFAULT_THRESHOLDS, l3: TEST_L3, nowMs: () => now,
    });

    // Drive 3 separate L2 enter/exit cycles via volatility spikes.
    for (let cycle = 0; cycle < 3; cycle++) {
      // Spike: two prices 15% apart within 5min → volatility fires → EXTREME.
      monitor.observeForPool(POOL_ID, makeSnapshot({ ts: now, price: "1.00" }));
      now += 1_000;
      monitor.observeForPool(POOL_ID, makeSnapshot({ ts: now, price: "1.15" }));
      expect(monitor.activeLevel(POOL_ID)).toBe("L2");

      // Calm down: advance past the 5-min window + 10-min stability, feed calm
      // prices so the circuit clears.
      now += 16 * 60_000;
      monitor.observeForPool(POOL_ID, makeSnapshot({ ts: now, price: "1.15" }));
      now += 1_000;
      monitor.observeForPool(POOL_ID, makeSnapshot({ ts: now, price: "1.15" }));
      if (cycle < 2) expect(monitor.activeLevel(POOL_ID)).toBe(null);
      now += 60_000;
    }

    // 3 L2 entries recorded within the 1h window → checkPreTick trips L3.
    const veto = monitor.checkPreTick(makeStrategyInput());
    expect(veto?.kind).toBe("emergency");
    expect(monitor.emergencyStop.isTripped()).toBe(true);
    const trips = getRiskEvents(db).filter((e) => e.kind === "emergency_trip");
    expect(trips.some((e) => e.metric === "repeated_l2")).toBe(true);
  });

  it("does not trip below the repeat threshold", () => {
    let now = BASE_NOW;
    const monitor = createRiskMonitor({
      db, thresholds: DEFAULT_THRESHOLDS, l3: TEST_L3, nowMs: () => now,
    });
    monitor.observeForPool(POOL_ID, makeSnapshot({ ts: now, price: "1.00" }));
    now += 1_000;
    monitor.observeForPool(POOL_ID, makeSnapshot({ ts: now, price: "1.15" }));
    // One L2 entry only → L2 veto, not emergency.
    const veto = monitor.checkPreTick(makeStrategyInput());
    expect(veto?.kind).toBe("extreme");
    expect(monitor.emergencyStop.isTripped()).toBe(false);
  });
});

describe("L3 auto-trip: data outage with open position", () => {
  beforeEach(() => { db = freshDb(); });

  it("trips when data is stale beyond outageMs AND a position is open", () => {
    let now = BASE_NOW;
    const monitor = createRiskMonitor({
      db, thresholds: DEFAULT_THRESHOLDS, l3: TEST_L3, nowMs: () => now,
    });
    monitor.observeForPool(POOL_ID, makeSnapshot({ ts: now }));
    now += TEST_L3.outageMs + 1_000;

    const veto = monitor.checkPreTick(makeInputWithPosition());
    expect(veto?.kind).toBe("emergency");
    expect(monitor.emergencyStop.isTripped()).toBe(true);
  });

  it("does NOT trip on outage when no position is open (L2 handles it)", () => {
    let now = BASE_NOW;
    const monitor = createRiskMonitor({
      db, thresholds: DEFAULT_THRESHOLDS, l3: TEST_L3, nowMs: () => now,
    });
    monitor.observeForPool(POOL_ID, makeSnapshot({ ts: now }));
    now += TEST_L3.outageMs + 1_000;

    monitor.checkPreTick(makeStrategyInput()); // empty positionBins
    expect(monitor.emergencyStop.isTripped()).toBe(false);
  });

  it("does NOT trip when data never flowed (cold start is not an outage)", () => {
    let now = BASE_NOW;
    const monitor = createRiskMonitor({
      db, thresholds: DEFAULT_THRESHOLDS, l3: TEST_L3, nowMs: () => now,
    });
    now += TEST_L3.outageMs * 10;
    monitor.checkPreTick(makeInputWithPosition());
    expect(monitor.emergencyStop.isTripped()).toBe(false);
  });
});

describe("L3 auto-trip: catastrophic 24h PnL", () => {
  beforeEach(() => { db = freshDb(); });

  it("trips when PnL falls below the L3 threshold", () => {
    let now = BASE_NOW;
    const monitor = createRiskMonitor({
      db, thresholds: DEFAULT_THRESHOLDS, l3: TEST_L3, nowMs: () => now,
    });
    monitor.set24hPnl(POOL_ID, -0.20); // below -0.15
    const veto = monitor.checkPreTick(makeStrategyInput());
    expect(veto?.kind).toBe("emergency");
  });

  it("L2 pnl territory (-0.06) does not trip L3", () => {
    let now = BASE_NOW;
    const monitor = createRiskMonitor({
      db, thresholds: DEFAULT_THRESHOLDS, l3: TEST_L3, nowMs: () => now,
    });
    monitor.observeForPool(POOL_ID, makeSnapshot({ ts: now }));
    monitor.set24hPnl(POOL_ID, -0.06);
    // evaluateL2 runs on the next observation → L2 EXTREME, not L3.
    now += 1_000;
    monitor.observeForPool(POOL_ID, makeSnapshot({ ts: now }));
    const veto = monitor.checkPreTick(makeStrategyInput());
    expect(veto?.kind).toBe("extreme");
    expect(monitor.emergencyStop.isTripped()).toBe(false);
  });
});

describe("per-source staleness circuit (max-ts masking fix)", () => {
  beforeEach(() => { db = freshDb(); });

  it("dead cetus feed trips L2 even while the aggregate snapshot ts stays fresh", () => {
    let now = BASE_NOW;
    const monitor = createRiskMonitor({
      db, thresholds: DEFAULT_THRESHOLDS, l3: TEST_L3, nowMs: () => now,
    });
    // Fresh snapshot keeps latestSnapshotTs current (binance is alive).
    monitor.observeForPool(POOL_ID, makeSnapshot({ ts: now }));
    expect(monitor.activeLevel(POOL_ID)).toBe(null);

    // Staleness sample: binance fresh, cetus dead for 4 minutes (> 180s).
    monitor.observeSourceStaleness(POOL_ID, makeStaleness({ sui: 5_000, cetus: 240_000 }));
    expect(monitor.activeLevel(POOL_ID)).toBe("L2");

    const events = getRiskEvents(db);
    expect(events.some((e) => e.metric === "source_stale_cetus")).toBe(true);
  });

  it("fires during a total outage when observeForPool never runs", () => {
    let now = BASE_NOW;
    const monitor = createRiskMonitor({
      db, thresholds: DEFAULT_THRESHOLDS, l3: TEST_L3, nowMs: () => now,
    });
    // Only staleness flows (marketAggregator.latest() would be throwing).
    monitor.observeSourceStaleness(POOL_ID, makeStaleness({ sui: 120_000, cetus: 240_000, derivatives: 700_000 }));
    expect(monitor.activeLevel(POOL_ID)).toBe("L2");
  });

  it("the staleness sample itself ages between observer ticks", () => {
    let now = BASE_NOW;
    const monitor = createRiskMonitor({
      db, thresholds: DEFAULT_THRESHOLDS, l3: TEST_L3, nowMs: () => now,
    });
    // Sample says sui is 30s stale — under the 60s threshold.
    monitor.observeSourceStaleness(POOL_ID, makeStaleness({ sui: 30_000 }));
    expect(monitor.activeLevel(POOL_ID)).toBe(null);
    // 40s later with no new sample: effective age 70s > 60s. A fresh pre-tick
    // evaluation must see it fire (re-evaluate via a new staleness ingest
    // carrying the same capture, simulated by advancing the clock and feeding
    // an already-old sample).
    now += 40_000;
    monitor.observeSourceStaleness(POOL_ID, makeStaleness({ sui: 70_000 }));
    expect(monitor.activeLevel(POOL_ID)).toBe("L2");
  });

  it("fresh sources do not fire", () => {
    let now = BASE_NOW;
    const monitor = createRiskMonitor({
      db, thresholds: DEFAULT_THRESHOLDS, l3: TEST_L3, nowMs: () => now,
    });
    monitor.observeSourceStaleness(POOL_ID, makeStaleness({ sui: 1_000, cetus: 5_000, derivatives: 10_000 }));
    expect(monitor.activeLevel(POOL_ID)).toBe(null);
  });
});

describe("configurable volatility recovery threshold", () => {
  beforeEach(() => { db = freshDb(); });

  it("volRecovered honours thresholds.volatilityRecovery", () => {
    let now = BASE_NOW;
    // Entry at 10%, recovery at 2% (tighter than the default 7%).
    const monitor = createRiskMonitor({
      db,
      thresholds: { ...DEFAULT_THRESHOLDS, volatilityRecovery: 0.02 },
      l3: TEST_L3,
      nowMs: () => now,
    });
    // Enter EXTREME via a 15% spike.
    monitor.observeForPool(POOL_ID, makeSnapshot({ ts: now, price: "1.00" }));
    now += 1_000;
    monitor.observeForPool(POOL_ID, makeSnapshot({ ts: now, price: "1.15" }));
    expect(monitor.activeLevel(POOL_ID)).toBe("L2");

    // 11 min later, vol is ~4% — below the entry threshold (all triggers clear)
    // but ABOVE the 2% recovery threshold → volRecovered must stay false.
    now += 11 * 60_000;
    monitor.observeForPool(POOL_ID, makeSnapshot({ ts: now, price: "1.15" }));
    now += 1_000;
    monitor.observeForPool(POOL_ID, makeSnapshot({ ts: now, price: "1.196" })); // 4% within window
    expect(monitor.volRecovered(POOL_ID)).toBe(false);
  });
});

describe("risk_events source discriminator (D3)", () => {
  beforeEach(() => { db = freshDb(); });

  it("a shadow-sourced monitor stamps source='shadow'; default is 'live'", () => {
    let now = BASE_NOW;
    const live = createRiskMonitor({
      db, thresholds: DEFAULT_THRESHOLDS, l3: TEST_L3, nowMs: () => now,
    });
    const shadow = createRiskMonitor({
      db, thresholds: DEFAULT_THRESHOLDS, l3: TEST_L3, nowMs: () => now,
      emergencyStop: live.emergencyStop,
      source: "shadow",
    });

    // Drive an L2 volatility trigger on each monitor.
    for (const m of [live, shadow]) {
      m.observeForPool(POOL_ID, makeSnapshot({ ts: now, price: "1.00" }));
      now += 1_000;
      m.observeForPool(POOL_ID, makeSnapshot({ ts: now, price: "1.15" }));
      now += 1_000;
    }

    const sources = db
      .prepare<{ source: string; n: number }, []>(
        "SELECT source, COUNT(*) AS n FROM risk_events GROUP BY source",
      )
      .all();
    const bySource = new Map(sources.map((r) => [r.source, r.n]));
    expect(bySource.get("live") ?? 0).toBeGreaterThan(0);
    expect(bySource.get("shadow") ?? 0).toBeGreaterThan(0);
  });
});
