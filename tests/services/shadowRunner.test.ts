/**
 * tests/services/shadowRunner.test.ts
 *
 * Unit tests for the ShadowRunner service.
 *
 * Coverage:
 *   - runShadowTick records a row in shadow_decisions
 *   - Both mlStrategy and ruleStrategy outputs are captured
 *   - DB write failure logs a warning and does NOT throw
 *   - mlStrategy plan() failure logs a warning and does NOT throw
 *   - ruleStrategy plan() failure omits the rule output but still records the ml output
 *   - state machine context fields (market_state, lending_pct, etc.) are persisted
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, resetDbCacheForTests } from "../../src/db/client.ts";
import { createShadowRunner } from "../../src/services/shadowRunner.ts";
import type { Strategy, StrategyInput } from "../../src/strategies/types.ts";
import type { StateMachine } from "../../src/state/machine.ts";
import type { StateContext } from "../../src/prediction/types.ts";
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
  tmpDir = mkdtempSync(join(tmpdir(), "shadow-runner-"));
  return openDb(join(tmpDir, "test.db"));
}

afterAll(() => {
  resetDbCacheForTests();
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_NOW = 1_700_000_000_000;
const POOL_ID = "0xpool";
const PM_ID = "0xpm";

function makeCtx(state: StateContext["state"] = "NORMAL"): StateContext {
  return {
    state,
    enteredAtMs: BASE_NOW,
    evalIntervalMs: 20 * 60 * 1000,
    halfWidth: 3,
    trendBias: 0.1,
    lendingPct: 0.35,
    toleranceBins: 2,
    minDwellMs: 15 * 60 * 1000,
  };
}

function makeStrategyInput(): StrategyInput {
  return {
    pm: {
      pmId: PM_ID,
      owner: "0xowner",
      poolId: POOL_ID,
      coinTypeA: "0x2::sui::SUI",
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
      coinTypeA: "0x2::sui::SUI",
      coinTypeB: "0x...::usdc::USDC",
      decimalsA: 9,
      decimalsB: 6,
      pricePairLabel: "SUI/USDC",
      defaultStrategyParams: { binWidth: 7, expectedFeeBps: 40 },
      lendingPolicy: {},
    },
  };
}

function makeQuietStrategy(reason: string): Strategy {
  return {
    name: `quiet-${reason}`,
    plan: async () => ({ kind: "quiet", reason }),
  };
}

function makeMockStateMachine(ctx?: StateContext): StateMachine {
  const c = ctx ?? makeCtx();
  return {
    advance: () => c,
    current: () => c,
  };
}

function countShadowRows(database: Database): number {
  return database
    .prepare<{ n: number }, []>("SELECT COUNT(*) as n FROM shadow_decisions")
    .get()?.n ?? 0;
}

function getLastShadowRow(database: Database): {
  pool_id: string;
  pm_id: string;
  market_state: string;
  strategy_output_kind: string;
  rule_output_kind: string | null;
  lending_pct: number | null;
  half_width: number | null;
  trend_bias: number | null;
} | null {
  return database
    .prepare<{
      pool_id: string;
      pm_id: string;
      market_state: string;
      strategy_output_kind: string;
      rule_output_kind: string | null;
      lending_pct: number | null;
      half_width: number | null;
      trend_bias: number | null;
    }, []>(
      `SELECT pool_id, pm_id, market_state, strategy_output_kind, rule_output_kind,
              lending_pct, half_width, trend_bias
       FROM shadow_decisions
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get() ?? null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("shadowRunner — basic recording", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("records one row in shadow_decisions per runShadowTick call", async () => {
    const runner = createShadowRunner({
      mlStrategy: makeQuietStrategy("ml-quiet"),
      ruleStrategy: makeQuietStrategy("rule-quiet"),
      stateMachine: makeMockStateMachine(),
      db,
      now: () => BASE_NOW,
    });

    expect(countShadowRows(db)).toBe(0);
    await runner.runShadowTick(makeStrategyInput());
    expect(countShadowRows(db)).toBe(1);
  });

  it("persists the correct pool_id and pm_id", async () => {
    const runner = createShadowRunner({
      mlStrategy: makeQuietStrategy("ml"),
      ruleStrategy: makeQuietStrategy("rule"),
      stateMachine: makeMockStateMachine(),
      db,
      now: () => BASE_NOW,
    });

    await runner.runShadowTick(makeStrategyInput());
    const row = getLastShadowRow(db);
    expect(row).not.toBeNull();
    expect(row!.pool_id).toBe(POOL_ID);
    expect(row!.pm_id).toBe(PM_ID);
  });

  it("persists mlStrategy output kind in strategy_output_kind", async () => {
    const runner = createShadowRunner({
      mlStrategy: makeQuietStrategy("ml-reason"),
      ruleStrategy: makeQuietStrategy("rule-reason"),
      stateMachine: makeMockStateMachine(),
      db,
      now: () => BASE_NOW,
    });

    await runner.runShadowTick(makeStrategyInput());
    const row = getLastShadowRow(db);
    expect(row!.strategy_output_kind).toBe("quiet");
  });

  it("persists ruleStrategy output kind in rule_output_kind", async () => {
    const runner = createShadowRunner({
      mlStrategy: makeQuietStrategy("ml"),
      ruleStrategy: makeQuietStrategy("rule"),
      stateMachine: makeMockStateMachine(),
      db,
      now: () => BASE_NOW,
    });

    await runner.runShadowTick(makeStrategyInput());
    const row = getLastShadowRow(db);
    expect(row!.rule_output_kind).toBe("quiet");
  });

  it("persists state machine context fields", async () => {
    const ctx = makeCtx("TREND");
    const runner = createShadowRunner({
      mlStrategy: makeQuietStrategy("ml"),
      ruleStrategy: makeQuietStrategy("rule"),
      stateMachine: makeMockStateMachine(ctx),
      db,
      now: () => BASE_NOW,
    });

    await runner.runShadowTick(makeStrategyInput());
    const row = getLastShadowRow(db);
    expect(row!.market_state).toBe("TREND");
    expect(row!.lending_pct).toBeCloseTo(ctx.lendingPct);
    expect(row!.half_width).toBe(ctx.halfWidth);
    expect(row!.trend_bias).toBeCloseTo(ctx.trendBias);
  });
});

describe("shadowRunner — resilience", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("does not throw when mlStrategy plan() throws", async () => {
    const failingMlStrategy: Strategy = {
      name: "failing-ml",
      plan: async () => { throw new Error("ml exploded"); },
    };

    const runner = createShadowRunner({
      mlStrategy: failingMlStrategy,
      ruleStrategy: makeQuietStrategy("rule"),
      stateMachine: makeMockStateMachine(),
      db,
      now: () => BASE_NOW,
    });

    await expect(runner.runShadowTick(makeStrategyInput())).resolves.toBeUndefined();
    // No row recorded when mlStrategy fails.
    expect(countShadowRows(db)).toBe(0);
  });

  it("still records a row when ruleStrategy plan() throws (rule_output_kind is null)", async () => {
    const failingRuleStrategy: Strategy = {
      name: "failing-rule",
      plan: async () => { throw new Error("rule exploded"); },
    };

    const runner = createShadowRunner({
      mlStrategy: makeQuietStrategy("ml"),
      ruleStrategy: failingRuleStrategy,
      stateMachine: makeMockStateMachine(),
      db,
      now: () => BASE_NOW,
    });

    await runner.runShadowTick(makeStrategyInput());
    const row = getLastShadowRow(db);
    expect(row).not.toBeNull();
    expect(row!.strategy_output_kind).toBe("quiet"); // ml output recorded
    expect(row!.rule_output_kind).toBeNull();          // rule output missing
  });

  it("does not throw when DB write fails (closed DB)", async () => {
    const closedDb = openDb(
      join(mkdtempSync(join(tmpdir(), "shadow-closed-")), "closed.db"),
    );
    closedDb.close();

    const runner = createShadowRunner({
      mlStrategy: makeQuietStrategy("ml"),
      ruleStrategy: makeQuietStrategy("rule"),
      stateMachine: makeMockStateMachine(),
      db: closedDb,
      now: () => BASE_NOW,
    });

    await expect(runner.runShadowTick(makeStrategyInput())).resolves.toBeUndefined();
  });
});

describe("shadowRunner — multiple ticks", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("records a separate row for each tick", async () => {
    const runner = createShadowRunner({
      mlStrategy: makeQuietStrategy("ml"),
      ruleStrategy: makeQuietStrategy("rule"),
      stateMachine: makeMockStateMachine(),
      db,
      now: () => BASE_NOW,
    });

    for (let i = 0; i < 5; i++) {
      await runner.runShadowTick(makeStrategyInput());
    }
    expect(countShadowRows(db)).toBe(5);
  });
});
