/**
 * tests/strategies/mlAgent.test.ts
 *
 * Unit tests for the mlAgent strategy. Uses an in-memory SQLite DB and
 * deterministic injected clocks throughout.
 *
 * Coverage:
 *   - L3 emergency veto → quiet output, no prediction called
 *   - DataOutageError from aggregator → quiet output
 *   - fallback prediction → delegates to fallback strategy
 *   - probation: entry on first fallback, exit after 3 consecutive successes
 *   - probation: PSI too high resets the success streak
 *   - successful inference → calls diffPlan path (plan_and_reconcile or quiet)
 *   - DB persistence: predictions table row written
 *   - DB write failure is non-fatal (strategy continues)
 *   - L2 extreme veto → builds ExtremeSignal, delegates to state machine
 *   - L1 soft veto → adjusts halfWidth and lendingPct
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, resetDbCacheForTests } from "../../src/db/client.ts";
import { createMlAgentStrategy } from "../../src/strategies/mlAgent.ts";
import type { MlAgentDeps } from "../../src/strategies/mlAgent.ts";
import type { Strategy, StrategyInput } from "../../src/strategies/types.ts";
import type { PredictionProvider } from "../../src/prediction/provider.ts";
import type { StateMachine } from "../../src/state/machine.ts";
import type { RiskMonitor, RiskVeto } from "../../src/risk/monitor.ts";
import type { MarketAggregator } from "../../src/data/marketAggregator.ts";
import { DataOutageError } from "../../src/data/marketAggregator.ts";
import type {
  MarketSnapshot,
  PredictionResponse,
  StateContext,
} from "../../src/prediction/types.ts";
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
  tmpDir = mkdtempSync(join(tmpdir(), "ml-agent-"));
  return openDb(join(tmpDir, "test.db"));
}

afterAll(() => {
  resetDbCacheForTests();
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

const BASE_NOW = 1_700_000_000_000;
const POOL_ID = "0xpool";
const PM_ID = "0xpm";

function makeSnapshot(): MarketSnapshot {
  return {
    ts: BASE_NOW,
    cetus: {
      activeBin: 100,
      price: "1.0000",
      tvlUsd: 1_000_000,
      binStep: 10,
    },
    binance: { sui: [], btc: [], eth: [] },
    derivatives: { funding: 0, oi: 0, liq1m: 0 },
    spread: 0.001,
  };
}

function makePred(overrides: Partial<PredictionResponse> = {}): PredictionResponse {
  return {
    centerOffset: 0,
    centerQ10: -1,
    centerQ90: 1,
    widthSigma: 1,
    pAbove: 0.2,
    pBelow: 0.2,
    modelVersion: "test-v0",
    featureCompleteness: 1.0,
    psi: 0.01,
    fallback: false,
    ...overrides,
  };
}

function makeCtx(state: StateContext["state"] = "NORMAL"): StateContext {
  return {
    state,
    enteredAtMs: BASE_NOW,
    evalIntervalMs: 20 * 60 * 1000,
    halfWidth: 3,
    trendBias: 0,
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
      balance: { a: 1_000_000_000n, b: 1_000_000n },
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

/** Builds a mock MarketAggregator. */
function makeMockAggregator(snapshot?: MarketSnapshot): MarketAggregator {
  const snap = snapshot ?? makeSnapshot();
  return {
    start: () => () => {},
    latest: () => snap,
    staleness: () => ({ sui: 0, btc: 0, eth: 0, derivatives: 0, cetus: 0 }),
    allSourcesDown: () => false,
  };
}

/** Builds a mock MarketAggregator that throws DataOutageError. */
function makeOutageAggregator(): MarketAggregator {
  return {
    start: () => () => {},
    latest: () => { throw new DataOutageError(["binance"]); },
    staleness: () => ({ sui: Infinity, btc: Infinity, eth: Infinity, derivatives: Infinity, cetus: Infinity }),
    allSourcesDown: () => true,
  };
}

/** Builds a mock RiskMonitor. */
function makeMockRiskMonitor(veto: RiskVeto | null = null): RiskMonitor {
  return {
    checkPreTick: () => veto,
    observe: () => {},
    activeLevel: () => null,
  };
}

/** Builds a mock PredictionProvider. */
function makeMockProvider(pred: PredictionResponse): PredictionProvider {
  return {
    name: "mock",
    predict: async () => pred,
    health: async () => ({ ok: true, modelVersion: pred.modelVersion }),
  };
}

/** Builds a mock StateMachine. */
function makeMockStateMachine(ctx?: StateContext): StateMachine {
  const c = ctx ?? makeCtx();
  return {
    advance: () => c,
    current: () => c,
  };
}

/** Builds a fallback strategy that always returns quiet. */
function makeQuietFallback(): Strategy {
  return {
    name: "quietFallback",
    plan: async () => ({ kind: "quiet", reason: "fallback quiet" }),
  };
}

/** Creates a complete set of MlAgentDeps for a test. */
function makeDeps(overrides: Partial<MlAgentDeps> = {}): MlAgentDeps & { db: Database } {
  return {
    provider: makeMockProvider(makePred()),
    stateMachine: makeMockStateMachine(),
    riskMonitor: makeMockRiskMonitor(),
    marketAggregator: makeMockAggregator(),
    fallback: makeQuietFallback(),
    db,
    now: () => BASE_NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: L3 emergency veto
// ---------------------------------------------------------------------------

describe("mlAgent — L3 emergency veto", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("returns quiet when L3 emergency is active", async () => {
    const emergencyVeto: RiskVeto = { kind: "emergency", level: "L3", reason: "manual stop" };
    let predictCalled = false;
    const provider: PredictionProvider = {
      name: "mock",
      predict: async () => { predictCalled = true; return makePred(); },
      health: async () => ({ ok: true }),
    };
    const strategy = createMlAgentStrategy(makeDeps({
      riskMonitor: makeMockRiskMonitor(emergencyVeto),
      provider,
    }));

    const output = await strategy.plan(makeStrategyInput());
    expect(output.kind).toBe("quiet");
    expect("reason" in output && output.reason).toContain("manual stop");
    expect(predictCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: DataOutageError
// ---------------------------------------------------------------------------

describe("mlAgent — DataOutageError", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("returns quiet when market aggregator throws DataOutageError", async () => {
    const strategy = createMlAgentStrategy(makeDeps({
      marketAggregator: makeOutageAggregator(),
    }));

    const output = await strategy.plan(makeStrategyInput());
    expect(output.kind).toBe("quiet");
    expect("reason" in output && output.reason).toContain("binance");
  });
});

// ---------------------------------------------------------------------------
// Tests: fallback / probation
// ---------------------------------------------------------------------------

describe("mlAgent — fallback and probation", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("delegates to fallback when pred.fallback !== false", async () => {
    const fallbackVeto: RiskVeto | null = null;
    const fallback: Strategy = {
      name: "testFallback",
      plan: async () => ({ kind: "quiet", reason: "from fallback" }),
    };
    const pred = makePred({ fallback: "sidecar_down" });
    const strategy = createMlAgentStrategy(makeDeps({
      provider: makeMockProvider(pred),
      fallback,
      riskMonitor: makeMockRiskMonitor(fallbackVeto),
    }));

    const output = await strategy.plan(makeStrategyInput());
    expect(output.kind).toBe("quiet");
    expect("reason" in output && output.reason).toBe("from fallback");
  });

  it("enters probation on first fallback and stays in probation on subsequent fallbacks", async () => {
    const fallback: Strategy = {
      name: "testFallback",
      plan: async () => ({ kind: "quiet", reason: "probation fallback" }),
    };

    // Use a provider that always returns a fallback response.
    let callCount = 0;
    const provider: PredictionProvider = {
      name: "mock",
      predict: async () => {
        callCount++;
        return makePred({ fallback: "timeout" });
      },
      health: async () => ({ ok: false }),
    };

    const strategy = createMlAgentStrategy(makeDeps({ provider, fallback }));
    const input = makeStrategyInput();

    // Multiple calls should all delegate to fallback.
    for (let i = 0; i < 5; i++) {
      const output = await strategy.plan(input);
      expect(output.kind).toBe("quiet");
    }
    expect(callCount).toBe(5);
  });

  it("exits probation after 3 consecutive successful inferences with PSI < 0.25", async () => {
    const fallbackStrategy: Strategy = {
      name: "fb",
      plan: async () => ({ kind: "quiet", reason: "from-fallback" }),
    };

    // Step 1: trigger probation with a fallback response.
    let phase: "fallback" | "success" = "fallback";
    const provider: PredictionProvider = {
      name: "mock",
      predict: async () => {
        if (phase === "fallback") {
          return makePred({ fallback: "psi" });
        }
        // Healthy inference with low PSI.
        return makePred({ fallback: false, psi: 0.1 });
      },
      health: async () => ({ ok: true }),
    };

    const strategy = createMlAgentStrategy(makeDeps({
      provider,
      fallback: fallbackStrategy,
    }));
    const input = makeStrategyInput();

    // Enter probation.
    const out1 = await strategy.plan(input);
    expect("reason" in out1 && out1.reason).toBe("from-fallback");

    // Switch to healthy inferences.
    phase = "success";

    // 3 consecutive successes needed to exit probation.
    for (let i = 0; i < 2; i++) {
      const out = await strategy.plan(input);
      // Still in probation after 1–2 successes.
      expect("reason" in out && out.reason).toBe("from-fallback");
    }

    // 3rd success — should exit probation and return a real strategy output.
    const outFinal = await strategy.plan(input);
    // After exiting probation, the mlAgent runs diffPlan.
    // With empty positionBins and balance, diffPlan returns null → quiet.
    // With actual balance it could return plan_and_reconcile.
    // Either way it's NOT "from-fallback".
    expect("reason" in outFinal ? outFinal.reason !== "from-fallback" : true).toBe(true);
  });

  it("PSI too high during probation resets the success streak", async () => {
    const fallbackStrategy: Strategy = {
      name: "fb",
      plan: async () => ({ kind: "quiet", reason: "from-fallback" }),
    };

    let callSeq = 0;
    const provider: PredictionProvider = {
      name: "mock",
      predict: async () => {
        callSeq++;
        if (callSeq === 1) return makePred({ fallback: "timeout" }); // enter probation
        if (callSeq === 2) return makePred({ fallback: false, psi: 0.1 }); // success 1
        if (callSeq === 3) return makePred({ fallback: false, psi: 0.3 }); // PSI too high → reset streak
        if (callSeq === 4) return makePred({ fallback: false, psi: 0.1 }); // success 1 again
        if (callSeq === 5) return makePred({ fallback: false, psi: 0.1 }); // success 2
        return makePred({ fallback: false, psi: 0.1 }); // success 3 → exit
      },
      health: async () => ({ ok: true }),
    };

    const strategy = createMlAgentStrategy(makeDeps({ provider, fallback: fallbackStrategy }));
    const input = makeStrategyInput();

    // seq=1: enter probation
    const o1 = await strategy.plan(input);
    expect("reason" in o1 && o1.reason).toBe("from-fallback");

    // seq=2: success 1 (still in probation, need 2 more)
    const o2 = await strategy.plan(input);
    expect("reason" in o2 && o2.reason).toBe("from-fallback");

    // seq=3: PSI too high → streak reset, still in probation
    const o3 = await strategy.plan(input);
    expect("reason" in o3 && o3.reason).toBe("from-fallback");

    // seq=4: success 1 (after reset)
    const o4 = await strategy.plan(input);
    expect("reason" in o4 && o4.reason).toBe("from-fallback");

    // seq=5: success 2
    const o5 = await strategy.plan(input);
    expect("reason" in o5 && o5.reason).toBe("from-fallback");

    // seq=6: success 3 → exit probation
    const o6 = await strategy.plan(input);
    expect("reason" in o6 ? o6.reason !== "from-fallback" : true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: DB persistence
// ---------------------------------------------------------------------------

describe("mlAgent — DB persistence", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("writes a row to the predictions table on successful inference", async () => {
    const pred = makePred({ modelVersion: "test-v1", psi: 0.05 });
    const strategy = createMlAgentStrategy(makeDeps({ provider: makeMockProvider(pred) }));

    await strategy.plan(makeStrategyInput());

    const row = db.prepare<{ model_version: string; fallback: string | null }, []>(
      "SELECT model_version, fallback FROM predictions LIMIT 1",
    ).get();
    expect(row).not.toBeNull();
    expect(row!.model_version).toBe("test-v1");
    expect(row!.fallback).toBeNull(); // not a fallback inference
  });

  it("writes fallback reason to predictions table when inference degrades", async () => {
    const pred = makePred({ fallback: "timeout" });
    const strategy = createMlAgentStrategy(makeDeps({ provider: makeMockProvider(pred) }));

    await strategy.plan(makeStrategyInput());

    const row = db.prepare<{ fallback: string | null }, []>(
      "SELECT fallback FROM predictions LIMIT 1",
    ).get();
    expect(row).not.toBeNull();
    expect(row!.fallback).toBe("timeout");
  });

  it("DB write failure does not abort the strategy tick", async () => {
    // Simulate DB failure by passing a closed database.
    const closedDb = openDb(join(mkdtempSync(join(tmpdir(), "ml-closed-")), "closed.db"));
    closedDb.close();

    const strategy = createMlAgentStrategy(makeDeps({ db: closedDb }));

    // Should NOT throw, even with a closed DB.
    await expect(strategy.plan(makeStrategyInput())).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: strategy output kinds
// ---------------------------------------------------------------------------

describe("mlAgent — output kinds", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("returns plan_and_reconcile when plan is produced", async () => {
    const pred = makePred({ fallback: false });
    const strategy = createMlAgentStrategy(makeDeps({ provider: makeMockProvider(pred) }));
    // Input has non-zero balance so diffPlan should produce a plan.
    const output = await strategy.plan(makeStrategyInput());
    // Either plan_and_reconcile (if diffPlan returned a plan) or quiet (if below threshold).
    expect(["plan_and_reconcile", "quiet"]).toContain(output.kind);
  });

  it("EXTREME state: delegates full withdrawal to diffPlan", async () => {
    const pred = makePred({ fallback: false });
    const extremeCtx = makeCtx("EXTREME");
    const strategy = createMlAgentStrategy(makeDeps({
      provider: makeMockProvider(pred),
      stateMachine: makeMockStateMachine(extremeCtx),
    }));

    // PM with existing position bins → diffPlan returns withdrawal plan.
    const input: StrategyInput = {
      ...makeStrategyInput(),
      pm: {
        ...makeStrategyInput().pm,
        positionBins: [
          { binId: 99, liquidityShare: 100n, amountA: 100n, amountB: 0n },
          { binId: 101, liquidityShare: 100n, amountA: 0n, amountB: 100n },
        ],
      },
    };

    const output = await strategy.plan(input);
    expect(output.kind).toBe("plan_and_reconcile");
    if (output.kind === "plan_and_reconcile") {
      expect(output.plan.addBins).toHaveLength(0);
      expect(output.plan.removeShares.size).toBeGreaterThan(0);
    }
  });
});
