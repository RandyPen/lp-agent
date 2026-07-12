/**
 * tests/strategies/v0Strategies.test.ts
 *
 * Unit tests for the two rule-based strategies (singleBin straddle,
 * multiBinSpot). These had ZERO dedicated coverage before Phase 2 —
 * the inverted side-split and active-bin placement shipped unnoticed because
 * nothing asserted the plan shapes.
 *
 * Invariants asserted for every plan:
 *   1. The active bin NEVER appears in addBins (policy).
 *   2. Physical side rule: bins above active carry only amountsA; bins below
 *      carry only amountsB (verified on mainnet).
 *   3. Σ per-bin amounts === addAmountA/addAmountB.
 *   4. positionValue (when injected by the execution layer) is included in
 *      the deployable capital.
 */

import { describe, it, expect } from "bun:test";
import { createSingleBinStrategy } from "../../src/strategies/singleBin.ts";
import { createMultiBinSpotStrategy } from "../../src/strategies/multiBinSpot.ts";
import type { StrategyInput, StrategyOutput } from "../../src/strategies/types.ts";
import type { PMState, PoolState, PriceObservation, RebalancePlan } from "../../src/domain/types.ts";
import type { PoolProfile } from "../../src/pools/types.ts";
import { emptyLendingState } from "../../src/sui/lending/types.ts";

const ACTIVE = 1445;

/** SUI/USDC-shaped profile: physical Pool<USDC=6, SUI=9>, inverted. */
function makeProfile(overrides: Partial<PoolProfile> = {}): PoolProfile {
  return {
    name: "sui-usdc",
    poolId: "0xpool",
    coinTypeA: "0x2::sui::SUI",
    coinTypeB: "0xusdc::usdc::USDC",
    decimalsA: 9,
    decimalsB: 6,
    poolCoinADecimals: 6,
    poolCoinBDecimals: 9,
    poolCoinAIsQuote: true,
    binStep: 50,
    pricePairLabel: "SUI/USDC",
    defaultStrategyParams: { binWidth: 10, expectedFeeBps: 25 },
    lendingPolicy: {},
    network: "mainnet",
    ...overrides,
  };
}

function makePm(opts: {
  balanceA?: bigint;
  balanceB?: bigint;
  feeBagA?: bigint;
  feeBagB?: bigint;
  positionBins?: PMState["positionBins"];
  positionValue?: { a: bigint; b: bigint };
} = {}): PMState {
  return {
    pmId: "0xpm",
    owner: "0xowner",
    poolId: "0xpool",
    coinTypeA: "0xusdc::usdc::USDC", // physical A
    coinTypeB: "0x2::sui::SUI",      // physical B
    balance: { a: opts.balanceA ?? 5_000_000n, b: opts.balanceB ?? 3_000_000_000n },
    feeBag: { a: opts.feeBagA ?? 0n, b: opts.feeBagB ?? 0n },
    positionBins: opts.positionBins ?? [],
    lending: emptyLendingState(),
    ...(opts.positionValue !== undefined ? { positionValue: opts.positionValue } : {}),
  };
}

function makePool(activeBinId = ACTIVE): PoolState {
  return { poolId: "0xpool", activeBinId, binStep: 50, feeRateBps: 25 };
}

function makeHistory(n: number, price0: number, stepFrac: number): PriceObservation[] {
  const out: PriceObservation[] = [];
  let p = price0;
  for (let i = 0; i < n; i++) {
    out.push({ price: p.toFixed(8), timestampMs: 1_000_000 + i * 60_000, source: "test" });
    p *= 1 + stepFrac;
  }
  return out;
}

function makeInput(opts: {
  pm?: PMState;
  pool?: PoolState;
  history?: PriceObservation[];
  profile?: PoolProfile;
} = {}): StrategyInput {
  const history = opts.history ?? makeHistory(30, 0.75, 0);
  return {
    pm: opts.pm ?? makePm(),
    pool: opts.pool ?? makePool(),
    spot: history[history.length - 1] ?? { price: "0.75", timestampMs: 0, source: "test" },
    history,
    profile: opts.profile ?? makeProfile(),
  };
}

function expectPlan(output: StrategyOutput): RebalancePlan {
  if (output.kind !== "plan_and_reconcile" && output.kind !== "plan_only") {
    throw new Error(`expected a plan output, got ${output.kind}: ${JSON.stringify(output)}`);
  }
  return output.plan;
}

/** Shared invariants for any produced plan. */
function assertPlanInvariants(plan: RebalancePlan, activeBin: number): void {
  expect(plan.addBins).not.toContain(activeBin);
  expect(plan.addBins.length).toBe(plan.addAmountsA.length);
  expect(plan.addBins.length).toBe(plan.addAmountsB.length);
  for (let i = 0; i < plan.addBins.length; i++) {
    const bin = plan.addBins[i]!;
    const a = plan.addAmountsA[i]!;
    const b = plan.addAmountsB[i]!;
    if (bin > activeBin) {
      expect(b).toBe(0n); // above active: physical A only
    } else {
      expect(a).toBe(0n); // below active: physical B only
    }
  }
  expect(plan.addAmountsA.reduce((s, v) => s + v, 0n)).toBe(plan.addAmountA);
  expect(plan.addAmountsB.reduce((s, v) => s + v, 0n)).toBe(plan.addAmountB);
  expect(plan.plannedActiveBinId).toBe(activeBin);
}

// ---------------------------------------------------------------------------
// singleBin (straddle)
// ---------------------------------------------------------------------------

describe("singleBin straddle", () => {
  const strategy = createSingleBinStrategy();

  it("empty PM → quiet", async () => {
    const out = await strategy.plan(makeInput({ pm: makePm({ balanceA: 0n, balanceB: 0n }) }));
    expect(out.kind).toBe("quiet");
  });

  it("deploys active±1 with physical sides, never the active bin", async () => {
    const out = await strategy.plan(makeInput());
    const plan = expectPlan(out);
    assertPlanInvariants(plan, ACTIVE);
    expect(plan.addBins).toEqual([ACTIVE - 1, ACTIVE + 1]);
    expect(plan.addAmountA).toBe(5_000_000n);      // physical A → above
    expect(plan.addAmountB).toBe(3_000_000_000n);  // physical B → below
  });

  it("in range (straddle brackets active) → quiet / fees-only reconcile", async () => {
    const positionBins = [
      { binId: ACTIVE - 1, liquidityShare: 10n, amountA: 0n, amountB: 0n },
      { binId: ACTIVE + 1, liquidityShare: 10n, amountA: 0n, amountB: 0n },
    ];
    const quiet = await strategy.plan(makeInput({ pm: makePm({ positionBins }) }));
    expect(quiet.kind).toBe("quiet");

    const withFees = await strategy.plan(
      makeInput({ pm: makePm({ positionBins, feeBagA: 1_000n }) }),
    );
    expect(withFees.kind).toBe("reconcile_only");
  });

  it("active outside the position range → full recenter with removeShares", async () => {
    const positionBins = [
      { binId: ACTIVE - 10, liquidityShare: 11n, amountA: 0n, amountB: 0n },
      { binId: ACTIVE - 8, liquidityShare: 22n, amountA: 0n, amountB: 0n },
    ];
    const out = await strategy.plan(makeInput({ pm: makePm({ positionBins }) }));
    const plan = expectPlan(out);
    expect(plan.removeShares.get(ACTIVE - 10)).toBe(11n);
    expect(plan.removeShares.get(ACTIVE - 8)).toBe(22n);
    assertPlanInvariants(plan, ACTIVE);
  });

  it("includes injected positionValue in the deployable capital (re-plan pass)", async () => {
    const positionBins = [
      { binId: ACTIVE - 10, liquidityShare: 11n, amountA: 0n, amountB: 0n },
    ];
    // The all-locked case: no idle balance at all.
    const pm = makePm({
      balanceA: 0n,
      balanceB: 0n,
      positionBins,
      positionValue: { a: 0n, b: 9_000_000_000n },
    });
    const out = await strategy.plan(makeInput({ pm }));
    const plan = expectPlan(out);
    expect(plan.addAmountB).toBe(9_000_000_000n);
    expect(plan.addBins).toEqual([ACTIVE - 1]);
  });
});

// ---------------------------------------------------------------------------
// multiBinSpot
// ---------------------------------------------------------------------------

describe("multiBinSpot", () => {
  const strategy = createMultiBinSpotStrategy();

  it("initial deploy: active excluded, physical sides, sums consistent", async () => {
    const out = await strategy.plan(makeInput());
    const plan = expectPlan(out);
    assertPlanInvariants(plan, ACTIVE);
    expect(plan.addBins.length).toBeGreaterThan(1);
    // Both sides deployed (capital exists on both).
    expect(plan.addAmountA).toBeGreaterThan(0n);
    expect(plan.addAmountB).toBeGreaterThan(0n);
  });

  it("in range within drift tolerance and no fees → quiet", async () => {
    // Position centered on active with a wide straddle.
    const positionBins = [];
    for (let k = ACTIVE - 4; k <= ACTIVE + 4; k++) {
      if (k === ACTIVE) continue;
      positionBins.push({ binId: k, liquidityShare: 10n, amountA: 0n, amountB: 0n });
    }
    const out = await strategy.plan(makeInput({ pm: makePm({ positionBins }) }));
    expect(out.kind).toBe("quiet");
  });

  it("drift beyond trigger → recenter removing every share", async () => {
    const positionBins = [];
    for (let k = ACTIVE - 12; k <= ACTIVE - 6; k++) {
      positionBins.push({ binId: k, liquidityShare: 7n, amountA: 0n, amountB: 0n });
    }
    const out = await strategy.plan(makeInput({ pm: makePm({ positionBins }) }));
    const plan = expectPlan(out);
    expect(plan.removeShares.size).toBe(positionBins.length);
    assertPlanInvariants(plan, ACTIVE);
  });

  it("includes injected positionValue in the deployable capital", async () => {
    const positionBins = [
      { binId: ACTIVE - 12, liquidityShare: 7n, amountA: 0n, amountB: 0n },
    ];
    const base = await strategy.plan(
      makeInput({ pm: makePm({ positionBins, balanceA: 1_000_000n, balanceB: 1_000_000_000n }) }),
    );
    const enriched = await strategy.plan(
      makeInput({
        pm: makePm({
          positionBins,
          balanceA: 1_000_000n,
          balanceB: 1_000_000_000n,
          positionValue: { a: 2_000_000n, b: 4_000_000_000n },
        }),
      }),
    );
    const basePlan = expectPlan(base);
    const enrichedPlan = expectPlan(enriched);
    expect(enrichedPlan.addAmountA).toBe(basePlan.addAmountA + 2_000_000n);
    expect(enrichedPlan.addAmountB).toBe(basePlan.addAmountB + 4_000_000_000n);
  });
});
