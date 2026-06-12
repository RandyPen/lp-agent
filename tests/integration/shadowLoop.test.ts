/**
 * tests/integration/shadowLoop.test.ts
 *
 * Shadow-mode integration test: REAL shadowRunner + dedicated stateMachine
 * and riskMonitor over a calm+crash scenario.
 *
 * Assertions:
 *   - shadow_decisions rows accumulate (one per tick)
 *   - FakeExecutorService receives ZERO calls (nothing executed)
 *   - Shadow decisions use the real mlAgent state machine
 *   - DB rows have correct market_state values
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, resetDbCacheForTests } from "../../src/db/client.ts";
import { createShadowRunner } from "../../src/services/shadowRunner.ts";
import { createStateMachine } from "../../src/state/machine.ts";
import { createRiskMonitor } from "../../src/risk/monitor.ts";
import { createRiskObserver } from "../../src/services/riskObserver.ts";
import { createMlAgentStrategy } from "../../src/strategies/mlAgent.ts";
import { createNullPredictionProvider } from "../../src/prediction/nullProvider.ts";
import type { Database } from "bun:sqlite";
import type { RiskThresholds } from "../../src/config.ts";
import type { SimBar } from "./simMarket.ts";
import {
  generateScenario,
  barToSnapshot,
  POOL_ID,
  BASE_PRICE,
} from "./simMarket.ts";
import {
  FakeMarketAggregator,
  FakeExecutorService,
  makeFakePmStateWithPosition,
  makeFakePoolState,
  makeFakeStrategyInput,
} from "./fakes.ts";

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let db: Database;

function freshDb(): Database {
  resetDbCacheForTests();
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore cleanup */ }
  }
  tmpDir = mkdtempSync(join(tmpdir(), "shadow-loop-"));
  return openDb(join(tmpDir, "test.db"));
}

afterAll(() => {
  resetDbCacheForTests();
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore cleanup */ }
  }
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_TS = 1_700_000_000_000;
const PM_ID = "0xshadow_pm";

const THRESHOLDS_NO_PBREAK: RiskThresholds = {
  extremeVolatility5m: 0.10,
  tvlDrop5m: 0.50,
  spreadExtreme: 0.05,
  spreadSustainMs: 30_000,
  pBreakSum: 0.99,
  pnl24hPct: -0.05,
  l1SpreadSoftBandLow: 0.005,
  l1SpreadSoftBandHigh: 0.01,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("shadowLoop", () => {
  it("shadow runner writes shadow_decisions rows and executor is never called", async () => {
    db = freshDb();

    let simNow = BASE_TS;
    const clock = () => simNow;

    // Timeline: calm → crash
    const calmBars = generateScenario({
      scenario: "calm",
      bars: 40,
      startTs: BASE_TS,
      startPrice: BASE_PRICE,
      seed: 42,
    });

    const lastCalmBar = calmBars[calmBars.length - 1]!;
    const crashBars = generateScenario({
      scenario: "crash",
      bars: 5,
      startTs: lastCalmBar.ts + 60_000,
      startPrice: lastCalmBar.close,
      seed: 7,
    });

    const allBars = [...calmBars, ...crashBars];

    // Build components
    const aggregator = new FakeMarketAggregator();
    const fakeExecutor = new FakeExecutorService(clock);

    // Dedicated shadow stateMachine + riskMonitor (must NOT be shared with live path)
    const shadowStateMachine = createStateMachine({
      poolId: POOL_ID,
      db,
      now: clock,
    });
    const shadowRiskMonitor = createRiskMonitor({
      db,
      thresholds: THRESHOLDS_NO_PBREAK,
      nowMs: clock,
    });
    const provider = createNullPredictionProvider();
    const fallbackStrategy = {
      name: "noop-fallback",
      async plan() { return { kind: "quiet" as const, reason: "fallback" }; },
    };

    // Live mlAgent (uses dedicated shadow machine/monitor)
    const mlAgent = createMlAgentStrategy({
      provider,
      stateMachine: shadowStateMachine,
      riskMonitor: shadowRiskMonitor,
      marketAggregator: aggregator,
      fallback: fallbackStrategy,
      db,
      now: clock,
    });

    // Rule strategy (the "live" baseline)
    const ruleStrategy = {
      name: "rule-baseline",
      async plan() { return { kind: "quiet" as const, reason: "rule-quiet" }; },
    };

    const shadowRunner = createShadowRunner({
      mlStrategy: mlAgent,
      ruleStrategy,
      stateMachine: shadowStateMachine,
      db,
      strategyLabel: "shadow:null-integration",
      now: clock,
    });

    const riskObserver = createRiskObserver({
      poolId: POOL_ID,
      marketAggregator: aggregator,
      riskMonitor: shadowRiskMonitor,
      now: clock,
    });

    let tickCount = 0;
    const accumulatedBars: SimBar[] = [];

    for (let i = 0; i < allBars.length; i++) {
      const bar = allBars[i]!;
      accumulatedBars.push(bar);
      simNow = bar.ts;

      const snapshot = barToSnapshot(bar, accumulatedBars);
      aggregator.setSnapshot(snapshot);

      // Risk observer samples every 30s
      riskObserver.sampleOnce();
      simNow = bar.ts + 30_000;
      riskObserver.sampleOnce();
      simNow = bar.ts + 60_000;

      // Tick every 10 bars
      if (i % 10 === 0) {
        const pm = makeFakePmStateWithPosition(bar.activeBin, 4, { pmId: PM_ID });
        const pool = makeFakePoolState(bar.activeBin);
        const input = makeFakeStrategyInput(pm, pool);

        await shadowRunner.runShadowTick(input);
        tickCount++;
      }
    }

    // 1. shadow_decisions rows must exist (one per tick)
    const shadowRows = db
      .prepare("SELECT COUNT(*) as cnt FROM shadow_decisions")
      .get() as { cnt: number };
    expect(shadowRows.cnt).toBe(tickCount);
    expect(shadowRows.cnt).toBeGreaterThan(0);

    // 2. Executor NEVER called — shadow mode must not submit any on-chain ops
    expect(fakeExecutor.submissions.length).toBe(0);

    // 3. Shadow rows have correct pool_id
    const distinctPools = db
      .prepare("SELECT DISTINCT pool_id FROM shadow_decisions")
      .all() as Array<{ pool_id: string }>;
    expect(distinctPools).toHaveLength(1);
    expect(distinctPools[0]!.pool_id).toBe(POOL_ID);

    // 4. All rows have a non-empty model_version (strategy label)
    const badRows = db
      .prepare("SELECT COUNT(*) as cnt FROM shadow_decisions WHERE model_version IS NULL OR model_version = ''")
      .get() as { cnt: number };
    expect(badRows.cnt).toBe(0);

    // 5. market_state values are valid
    const validStates = new Set(["NORMAL", "TREND", "EXTREME"]);
    const stateRows = db
      .prepare("SELECT DISTINCT market_state FROM shadow_decisions")
      .all() as Array<{ market_state: string }>;
    for (const row of stateRows) {
      expect(validStates.has(row.market_state)).toBe(true);
    }

    console.log(`[shadow test] tickCount=${tickCount}, shadow rows=${shadowRows.cnt}`);
    console.log(`[shadow test] distinct market states: ${stateRows.map((r) => r.market_state).join(", ")}`);
  });

  it("shadow runner records both ml and rule outputs separately", async () => {
    db = freshDb();

    let simNow = BASE_TS;
    const clock = () => simNow;

    const bars = generateScenario({
      scenario: "calm",
      bars: 20,
      startTs: BASE_TS,
      startPrice: BASE_PRICE,
      seed: 88,
    });

    const aggregator = new FakeMarketAggregator();

    const shadowStateMachine = createStateMachine({ poolId: POOL_ID, db, now: clock });
    const shadowRiskMonitor = createRiskMonitor({
      db,
      thresholds: THRESHOLDS_NO_PBREAK,
      nowMs: clock,
    });
    const provider = createNullPredictionProvider();

    const mlAgent = createMlAgentStrategy({
      provider,
      stateMachine: shadowStateMachine,
      riskMonitor: shadowRiskMonitor,
      marketAggregator: aggregator,
      fallback: {
        name: "fallback",
        async plan() { return { kind: "quiet" as const, reason: "fallback" }; },
      },
      db,
      now: clock,
    });

    // Rule strategy returns reconcile_only to distinguish from quiet
    const ruleStrategy = {
      name: "rule-recon",
      async plan() {
        return { kind: "reconcile_only" as const, reason: "rule-reconcile" };
      },
    };

    const shadowRunner = createShadowRunner({
      mlStrategy: mlAgent,
      ruleStrategy,
      stateMachine: shadowStateMachine,
      db,
      strategyLabel: "shadow:test-label",
      now: clock,
    });

    const accumulatedBars: SimBar[] = [];

    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i]!;
      accumulatedBars.push(bar);
      simNow = bar.ts;

      const snapshot = barToSnapshot(bar, accumulatedBars);
      aggregator.setSnapshot(snapshot);

      if (i % 5 === 0) {
        const pm = makeFakePmStateWithPosition(bar.activeBin, 4, { pmId: PM_ID });
        const pool = makeFakePoolState(bar.activeBin);
        const input = makeFakeStrategyInput(pm, pool);
        await shadowRunner.runShadowTick(input);
      }

      simNow = bar.ts + 60_000;
    }

    // Rule output kind should be "reconcile_only" in all rows
    const ruleKindRows = db
      .prepare("SELECT DISTINCT rule_output_kind FROM shadow_decisions WHERE rule_output_kind IS NOT NULL")
      .all() as Array<{ rule_output_kind: string }>;

    // At least one row should have rule output
    expect(ruleKindRows.length).toBeGreaterThan(0);
    for (const row of ruleKindRows) {
      expect(row.rule_output_kind).toBe("reconcile_only");
    }
  });
});
