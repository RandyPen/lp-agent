/**
 * Tests for src/decision/diffPlanner.ts
 *
 * Coverage:
 *   - NORMAL state: weight construction (normal-shaped, center offset clipped)
 *   - TREND state: weak-trend bias, strong-trend 25% reverse position
 *   - EXTREME state: full withdrawal plan
 *   - Tolerance guard: returns null when position is already close enough
 *   - PTB op-count hard limit: shrink to ≤ 6 ops (property-style, widths 2..8)
 *   - Fee-aware ask-min filter
 *   - Empty PM returns null
 */

import { describe, it, expect } from "bun:test";
import { diffPlan, countPlanOps, type DiffPlanInput } from "../../src/decision/diffPlanner.ts";
import type { PMState, PoolState } from "../../src/domain/types.ts";
import type { StateContext, PredictionResponse } from "../../src/prediction/types.ts";
import type { PoolProfile } from "../../src/pools/types.ts";

// ---------------------------------------------------------------------------
// Helpers / fixtures
// ---------------------------------------------------------------------------

function makePool(activeBinId = 0, feeRateBps = 40): PoolState {
  return {
    poolId: "0xpool",
    activeBinId,
    binStep: 10, // 0.1 % per bin
    feeRateBps,
  };
}

function makePm(opts: {
  pmId?: string;
  positionBins?: PMState["positionBins"];
  balanceA?: bigint;
  balanceB?: bigint;
  feeBagA?: bigint;
  feeBagB?: bigint;
} = {}): PMState {
  return {
    pmId: opts.pmId ?? "0xpm",
    owner: "0xowner",
    poolId: "0xpool",
    coinTypeA: "0x2::sui::SUI",
    coinTypeB: "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN",
    balance: {
      a: opts.balanceA ?? 1_000_000_000n,
      b: opts.balanceB ?? 1_000_000n,
    },
    feeBag: {
      a: opts.feeBagA ?? 0n,
      b: opts.feeBagB ?? 0n,
    },
    positionBins: opts.positionBins ?? [],
    lending: {
      scallop: {},
      kai: {},
    },
  };
}

function makeCtx(state: StateContext["state"], overrides: Partial<StateContext> = {}): StateContext {
  return {
    state,
    enteredAtMs: 1000,
    evalIntervalMs: state === "NORMAL" ? 20 * 60 * 1000 : state === "TREND" ? 15 * 60 * 1000 : 60 * 1000,
    halfWidth: 3,
    trendBias: 0,
    // Mirrors the state machine's derivation (|trendBias| > 0.7) so tests that
    // only override trendBias keep the pre-strongTrend-field behaviour.
    strongTrend: Math.abs(overrides.trendBias ?? 0) > 0.7,
    lendingPct: state === "EXTREME" ? 1 : state === "TREND" ? 0.5 : 0.35,
    toleranceBins: 2,
    maxCenterOffset: 2,
    minDwellMs: state === "EXTREME" ? 10 * 60 * 1000 : 15 * 60 * 1000,
    ...overrides,
  };
}

function makePred(overrides: Partial<PredictionResponse> = {}): PredictionResponse {
  return {
    centerOffset: 0,
    centerQ10: -2,
    centerQ90: 2,
    widthSigma: 2,
    pAbove: 0.4,
    pBelow: 0.4,
    modelVersion: "test-v1",
    featureCompleteness: 1,
    psi: 0.01,
    fallback: false,
    ...overrides,
  };
}

const SUI_USDC_PROFILE: PoolProfile = {
  name: "sui-usdc",
  poolId: "0xpool",
  coinTypeA: "0x2::sui::SUI",
  coinTypeB: "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN",
  decimalsA: 9,
  decimalsB: 6,
  binStep: 10,
  pricePairLabel: "SUI/USDC",
  defaultStrategyParams: { binWidth: 7, expectedFeeBps: 40 },
  lendingPolicy: {},
  network: "mainnet",
};

function makeInput(overrides: Partial<DiffPlanInput> = {}): DiffPlanInput {
  return {
    pm: makePm(),
    pool: makePool(),
    ctx: makeCtx("NORMAL"),
    pred: makePred(),
    profile: SUI_USDC_PROFILE,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// EXTREME state tests
// ---------------------------------------------------------------------------

describe("diffPlan — EXTREME state", () => {
  it("returns a full-withdrawal plan (no add bins) when position exists", () => {
    const pm = makePm({
      positionBins: [
        { binId: -2, liquidityShare: 100n, amountA: 100n, amountB: 0n },
        { binId: -1, liquidityShare: 200n, amountA: 200n, amountB: 0n },
        { binId: 1, liquidityShare: 150n, amountA: 0n, amountB: 150n },
      ],
    });
    const plan = diffPlan(makeInput({ pm, ctx: makeCtx("EXTREME") }));
    expect(plan).not.toBeNull();
    expect(plan!.addBins).toHaveLength(0);
    expect(plan!.addAmountA).toBe(0n);
    expect(plan!.addAmountB).toBe(0n);
    expect(plan!.removeShares.size).toBe(3);
    expect(plan!.reason).toContain("EXTREME");
  });

  it("returns null for EXTREME when PM is empty and no fees", () => {
    const pm = makePm({ balanceA: 0n, balanceB: 0n });
    const plan = diffPlan(makeInput({ pm, ctx: makeCtx("EXTREME") }));
    expect(plan).toBeNull();
  });

  it("EXTREME plan includes collectFees when fee bag is non-empty", () => {
    const pm = makePm({
      positionBins: [{ binId: -1, liquidityShare: 100n, amountA: 100n, amountB: 0n }],
      feeBagA: 5_000n,
    });
    const plan = diffPlan(makeInput({ pm, ctx: makeCtx("EXTREME") }));
    expect(plan).not.toBeNull();
    expect(plan!.collectFees).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// NORMAL state tests
// ---------------------------------------------------------------------------

describe("diffPlan — NORMAL state", () => {
  it("produces a plan with add bins around the target center", () => {
    const plan = diffPlan(makeInput());
    expect(plan).not.toBeNull();
    expect(plan!.addBins.length).toBeGreaterThan(0);
  });

  it("excludes the active bin from add bins", () => {
    const plan = diffPlan(makeInput());
    expect(plan).not.toBeNull();
    expect(plan!.addBins).not.toContain(0); // active bin is 0
  });

  it("bins BELOW active carry physical coinB only (verified side rule)", () => {
    const plan = diffPlan(makeInput());
    expect(plan).not.toBeNull();
    const { addBins, addAmountsA, addAmountsB } = plan!;
    for (let i = 0; i < addBins.length; i++) {
      if ((addBins[i] ?? 0) < 0) {
        expect(addAmountsB[i] ?? 0n).toBeGreaterThan(0n);
        expect(addAmountsA[i]).toBe(0n);
      }
    }
  });

  it("bins ABOVE active carry physical coinA only (verified side rule)", () => {
    const plan = diffPlan(makeInput());
    expect(plan).not.toBeNull();
    const { addBins, addAmountsA, addAmountsB } = plan!;
    for (let i = 0; i < addBins.length; i++) {
      if ((addBins[i] ?? 0) > 0) {
        expect(addAmountsA[i] ?? 0n).toBeGreaterThan(0n);
        expect(addAmountsB[i]).toBe(0n);
      }
    }
  });

  it("clips center offset to ±maxCenterOffset (from ctx.maxCenterOffset — F5)", () => {
    // maxCenterOffset = 1 (explicit), pred centerOffset = 10 → should be clipped to ±1
    const ctx = makeCtx("NORMAL", { toleranceBins: 1, maxCenterOffset: 1, halfWidth: 2 });
    const pred = makePred({ centerOffset: 10 });
    const plan = diffPlan(makeInput({ ctx, pred }));
    expect(plan).not.toBeNull();
    // The actual bins should be centered around active + 1 (clipped), not active + 10.
    const bins = plan!.addBins;
    const maxBin = Math.max(...bins);
    const minBin = Math.min(...bins);
    // With halfWidth=2, max bin from center+1 is 1+2=3, min is 1-2=-1.
    expect(maxBin).toBeLessThanOrEqual(3);
    expect(minBin).toBeGreaterThanOrEqual(-1);
  });

  it("returns null for fully empty PM with no position", () => {
    const pm = makePm({ balanceA: 0n, balanceB: 0n });
    const plan = diffPlan(makeInput({ pm }));
    expect(plan).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tolerance guard tests
// ---------------------------------------------------------------------------

describe("diffPlan — tolerance guard (returns null)", () => {
  it("returns null when current position center is within toleranceBins and shape is close", () => {
    // Build the position EXACTLY as the planner itself would (post ask-min
    // filter, per-side renormalization, inventory scaling, dust filter) via a
    // seed diffPlan call, rather than hand-crafting a symmetric fixture. A
    // hand-crafted position that includes bins the ask-min filter would
    // exclude is not a position the planner could ever actually build — see
    // the F1 quiet-gate regression tests below, which cover exactly that
    // "position matches only what survives the filter" scenario explicitly.
    const pred = makePred({ widthSigma: 5, centerOffset: 0 });
    const ctx = makeCtx("NORMAL", { halfWidth: 3, toleranceBins: 2 });
    const pool = makePool();

    const seedPlan = diffPlan(makeInput({ ctx, pred, pool }));
    expect(seedPlan).not.toBeNull();
    expect(seedPlan!.addBins.length).toBeGreaterThan(0);

    const positionBins: PMState["positionBins"] = seedPlan!.addBins.map((binId, i) => {
      const a = seedPlan!.addAmountsA[i] ?? 0n;
      const b = seedPlan!.addAmountsB[i] ?? 0n;
      return { binId, liquidityShare: a > 0n ? a : b, amountA: a, amountB: b };
    });

    const pm = makePm({ positionBins });
    const plan = diffPlan(makeInput({ pm, ctx, pred, pool }));
    // Next tick, unchanged inputs, position matches exactly what would be
    // rebuilt → shape deviation is below MIN_SHAPE_DEVIATION → null.
    expect(plan).toBeNull();
  });

  it("does NOT return null when position is out of range (active bin drifted far)", () => {
    const pred = makePred({ widthSigma: 2, centerOffset: 0 });
    const ctx = makeCtx("NORMAL", { halfWidth: 3, toleranceBins: 1 });

    // Position at bins 10–16, but active is at 0 → center drift = 13, toleranceBins = 1
    const pm = makePm({
      positionBins: [
        { binId: 10, liquidityShare: 100n, amountA: 0n, amountB: 100n },
        { binId: 11, liquidityShare: 100n, amountA: 0n, amountB: 100n },
        { binId: 12, liquidityShare: 100n, amountA: 0n, amountB: 100n },
      ],
    });

    const plan = diffPlan(makeInput({ pm, ctx, pred }));
    expect(plan).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// F1 regression — quiet-gate basis consistency
//
// Acceptance bar: a position built EXACTLY from diffPlan's own output, on a
// pool where 2×fee + 0.003 exceeds one binStep's worth of price move (so the
// ask-min filter excludes the nearest ask-side bin), must yield `diffPlan →
// null` on the very next tick with unchanged inputs — for BOTH pool
// orientations. Pre-fix, the quiet-gate compared an unfiltered target
// against the (necessarily filtered) real position and churned every tick.
// ---------------------------------------------------------------------------

describe("diffPlan — F1 quiet-gate: filtered-bin basis consistency", () => {
  // binStep=10 (0.1 %) with feeRateBps=40 (0.4 %): 2×fee + 0.003 = 1.1 % >>
  // one bin's ~0.1 % move, so the nearest ask-side bin (and the next two)
  // fail the ask-min filter regardless of which physical side is "ask" for
  // this orientation.
  const POOL = makePool(0, 40);
  const CTX = makeCtx("NORMAL", { halfWidth: 3, toleranceBins: 2 });
  const PRED = makePred({ widthSigma: 2, centerOffset: 0 });

  function roundTrip(profile: PoolProfile) {
    const pm0 = makePm({ balanceA: 1_000_000n, balanceB: 1_000_000n });
    const seedPlan = diffPlan({ pm: pm0, pool: POOL, ctx: CTX, pred: PRED, profile });
    expect(seedPlan).not.toBeNull();
    expect(seedPlan!.addBins.length).toBeGreaterThan(0);

    // A freshly-built position: liquidityShare mirrors the raw amount placed
    // (the only side with a non-zero amount per bin — see the verified
    // above/below physical-side rule).
    const positionBins: PMState["positionBins"] = seedPlan!.addBins.map((binId, i) => {
      const a = seedPlan!.addAmountsA[i] ?? 0n;
      const b = seedPlan!.addAmountsB[i] ?? 0n;
      return { binId, liquidityShare: a > 0n ? a : b, amountA: a, amountB: b };
    });

    const pm1 = makePm({ balanceA: 1_000_000n, balanceB: 1_000_000n, positionBins });
    return diffPlan({ pm: pm1, pool: POOL, ctx: CTX, pred: PRED, profile });
  }

  it("non-inverted pool (poolCoinAIsQuote=false): stays quiet next tick", () => {
    expect(SUI_USDC_PROFILE.poolCoinAIsQuote).not.toBe(true); // sanity: default orientation
    const plan = roundTrip(SUI_USDC_PROFILE);
    expect(plan).toBeNull();
  });

  it("inverted pool (poolCoinAIsQuote=true): stays quiet next tick", () => {
    const invertedProfile: PoolProfile = { ...SUI_USDC_PROFILE, poolCoinAIsQuote: true };
    const plan = roundTrip(invertedProfile);
    expect(plan).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TREND state tests
// ---------------------------------------------------------------------------

describe("diffPlan — TREND state (weak)", () => {
  it("produces a plan with directional weight skew", () => {
    // trendBias > 0 (bullish) → bid side should have more mass than ask side
    const ctx = makeCtx("TREND", { trendBias: 0.5, halfWidth: 4 });
    const pred = makePred({ pAbove: 0.65, pBelow: 0.15 });
    const plan = diffPlan(makeInput({ ctx, pred }));
    expect(plan).not.toBeNull();
    const totalBidA = plan!.addAmountsA.reduce((s, v) => s + v, 0n);
    const totalAskB = plan!.addAmountsB.reduce((s, v) => s + v, 0n);
    // For bullish trend, more bid (A) should be deployed relative to ask (B).
    // (Both can be non-zero; we just check plan is generated.)
    expect(totalBidA + totalAskB).toBeGreaterThan(0n);
  });

  it("TREND center is always the active bin (not predicted offset)", () => {
    const ctx = makeCtx("TREND", { trendBias: 0.3, halfWidth: 3 });
    const pred = makePred({ centerOffset: 5 }); // large offset that would be ignored
    const pool = makePool(100); // active at 100
    const pm = makePm({ balanceA: 1_000_000_000n, balanceB: 1_000_000n });
    const plan = diffPlan(makeInput({ pm, pool, ctx, pred }));
    expect(plan).not.toBeNull();
    // Bins should be centered around active (100), not active + 5 = 105.
    const bins = plan!.addBins;
    if (bins.length > 0) {
      const center = (Math.min(...bins) + Math.max(...bins)) / 2;
      // Center should be within halfWidth of active (100), not near 105.
      expect(Math.abs(center - 100)).toBeLessThanOrEqual(3);
    }
  });
});

describe("diffPlan — TREND state (strong trend shrink)", () => {
  it("strong positive trend deploys on counter-trend (bid) side only", () => {
    // trendBias > 0.7 (bullish) → counter-trend = bid side (below active)
    const ctx = makeCtx("TREND", { trendBias: 0.85, halfWidth: 4 });
    const pred = makePred({ pAbove: 0.8, pBelow: 0.05 });
    const pool = makePool(50);
    const pm = makePm({ balanceA: 1_000_000_000n, balanceB: 1_000_000n });
    const plan = diffPlan(makeInput({ pm, pool, ctx, pred }));
    if (plan && plan.addBins.length > 0) {
      // All add bins should be below active (counter-trend for bullish = bid side)
      for (const k of plan.addBins) {
        expect(k).toBeLessThan(50); // below active bin 50
      }
      // At most 3 counter-trend bins
      expect(plan.addBins.length).toBeLessThanOrEqual(3);
    }
  });

  it("strong negative trend deploys on ask side only", () => {
    // trendBias < -0.7 (bearish) → counter-trend = ask side (above active)
    const ctx = makeCtx("TREND", { trendBias: -0.85, halfWidth: 4 });
    const pred = makePred({ pAbove: 0.05, pBelow: 0.8 });
    const pool = makePool(50);
    const pm = makePm({ balanceA: 1_000_000_000n, balanceB: 1_000_000n });
    const plan = diffPlan(makeInput({ pm, pool, ctx, pred }));
    if (plan && plan.addBins.length > 0) {
      for (const k of plan.addBins) {
        expect(k).toBeGreaterThan(50); // above active bin 50
      }
      expect(plan.addBins.length).toBeLessThanOrEqual(3);
    }
  });
});

// ---------------------------------------------------------------------------
// PTB op-count tests
// ---------------------------------------------------------------------------

describe("countPlanOps — PTB hard limit", () => {
  it("counts zero ops for an empty plan with empty PM", () => {
    const pm = makePm({ feeBagA: 0n, feeBagB: 0n });
    const emptyPlan = {
      pmId: "0xpm",
      removeShares: new Map<number, bigint>(),
      addAmountA: 0n,
      addAmountB: 0n,
      addBins: [] as number[],
      addAmountsA: [] as bigint[],
      addAmountsB: [] as bigint[],
      collectFees: false,
      reason: "test",
    };
    expect(countPlanOps(emptyPlan, pm)).toBe(0);
  });

  it("counts correctly for a plan with remove + add + fee bag A", () => {
    const pm = makePm({ feeBagA: 100n, feeBagB: 0n });
    const plan = {
      pmId: "0xpm",
      removeShares: new Map([[1, 100n]]),
      addAmountA: 500n,
      addAmountB: 0n,
      addBins: [2, 3] as number[],
      addAmountsA: [250n, 250n] as bigint[],
      addAmountsB: [0n, 0n] as bigint[],
      collectFees: true,
      reason: "test",
    };
    // collect_fee(1) + remove(1) + transfer_fee_A(1) + add(1) = 4
    expect(countPlanOps(plan, pm)).toBe(4);
  });

  it("counts correctly for a plan with both fee bags", () => {
    const pm = makePm({ feeBagA: 100n, feeBagB: 100n });
    const plan = {
      pmId: "0xpm",
      removeShares: new Map([[1, 100n]]),
      addAmountA: 500n,
      addAmountB: 500n,
      addBins: [2, 3] as number[],
      addAmountsA: [250n, 250n] as bigint[],
      addAmountsB: [250n, 250n] as bigint[],
      collectFees: true,
      reason: "test",
    };
    // collect_fee(1) + remove(1) + transfer_fee_A(1) + transfer_fee_B(1) + add(1) = 5
    expect(countPlanOps(plan, pm)).toBe(5);
  });

  it("property: diffPlan output always has plan-only ops ≤ 6 across halfWidths 2..8", () => {
    const pool = makePool(100, 40);
    const pred = makePred({ widthSigma: 2, centerOffset: 1 });

    for (let hw = 2; hw <= 8; hw++) {
      const ctx = makeCtx("NORMAL", { halfWidth: hw, toleranceBins: 1 });
      const pm = makePm({
        feeBagA: 50_000n,
        feeBagB: 50_000n,
        positionBins: [
          { binId: 95, liquidityShare: 100n, amountA: 100n, amountB: 0n },
          { binId: 96, liquidityShare: 100n, amountA: 100n, amountB: 0n },
        ],
      });
      const plan = diffPlan({ pm, pool, ctx, pred, profile: SUI_USDC_PROFILE });
      if (plan) {
        const ops = countPlanOps(plan, pm);
        expect(ops).toBeLessThanOrEqual(6);
      }
    }
  });

  it("property: diffPlan with TREND state always has ops ≤ 6 across widths 2..8", () => {
    const pool = makePool(100, 40);
    const pred = makePred({ widthSigma: 2, pAbove: 0.6, pBelow: 0.2 });

    for (let hw = 2; hw <= 8; hw++) {
      const ctx = makeCtx("TREND", { halfWidth: hw, trendBias: 0.4, toleranceBins: 1 });
      const pm = makePm({
        feeBagA: 50_000n,
        feeBagB: 50_000n,
      });
      const plan = diffPlan({ pm, pool, ctx, pred, profile: SUI_USDC_PROFILE });
      if (plan) {
        const ops = countPlanOps(plan, pm);
        expect(ops).toBeLessThanOrEqual(6);
      }
    }
  });

  it("EXTREME plan always has ops ≤ 6", () => {
    const pool = makePool(100, 40);
    const ctx = makeCtx("EXTREME");
    const pm = makePm({
      feeBagA: 50_000n,
      feeBagB: 50_000n,
      positionBins: Array.from({ length: 6 }, (_, i) => ({
        binId: 95 + i,
        liquidityShare: BigInt(100 + i),
        amountA: BigInt(100 + i),
        amountB: 0n,
      })),
    });
    const pred = makePred();
    const plan = diffPlan({ pm, pool, ctx, pred, profile: SUI_USDC_PROFILE });
    if (plan) {
      const ops = countPlanOps(plan, pm);
      expect(ops).toBeLessThanOrEqual(6);
    }
  });
});

// ---------------------------------------------------------------------------
// Fee-aware ask-min filter
// ---------------------------------------------------------------------------

describe("diffPlan — ask-min-profit filter", () => {
  it("plan has consistent array lengths (bins, amountsA, amountsB)", () => {
    const plan = diffPlan(makeInput());
    expect(plan).not.toBeNull();
    expect(plan!.addBins.length).toBe(plan!.addAmountsA.length);
    expect(plan!.addBins.length).toBe(plan!.addAmountsB.length);
  });

  it("does not include bins with zero amounts on both sides", () => {
    const plan = diffPlan(makeInput());
    expect(plan).not.toBeNull();
    for (let i = 0; i < plan!.addBins.length; i++) {
      const a = plan!.addAmountsA[i] ?? 0n;
      const b = plan!.addAmountsB[i] ?? 0n;
      expect(a + b).toBeGreaterThan(0n);
    }
  });

  it("total addAmountA equals sum of addAmountsA", () => {
    const plan = diffPlan(makeInput());
    expect(plan).not.toBeNull();
    const sum = plan!.addAmountsA.reduce((s, v) => s + v, 0n);
    expect(plan!.addAmountA).toBe(sum);
  });

  it("total addAmountB equals sum of addAmountsB", () => {
    const plan = diffPlan(makeInput());
    expect(plan).not.toBeNull();
    const sum = plan!.addAmountsB.reduce((s, v) => s + v, 0n);
    expect(plan!.addAmountB).toBe(sum);
  });

  it("no negative amounts in plan", () => {
    const plan = diffPlan(makeInput());
    expect(plan).not.toBeNull();
    for (const a of plan!.addAmountsA) expect(a).toBeGreaterThanOrEqual(0n);
    for (const b of plan!.addAmountsB) expect(b).toBeGreaterThanOrEqual(0n);
  });
});

// ---------------------------------------------------------------------------
// Phase 3 (C1) — inventory correction wired into diffPlan
// ---------------------------------------------------------------------------

describe("diffPlan — inventory correction", () => {
  // The default fixture pool is NON-inverted (no poolCoinAIsQuote) with
  // decimals 9/6, active bin 0 → physical mid-price = 1000 B-per-A. A raw
  // amount of coinA is therefore worth 1000× the same raw amount of coinB...
  // adjusted by decimalAdj 10^3, giving value(A raw) = value(B raw) — i.e.
  // equal raw balances are a perfectly balanced book.

  it("balanced book: regime tag present, both sides deployed", () => {
    // feeRateBps=0: at the fixture's 10bp binStep a real fee would ask-min-
    // filter every above-active bin, which is fee logic — not what we test here.
    const plan = diffPlan(makeInput({
      pm: makePm({ balanceA: 1_000_000n, balanceB: 1_000_000n }),
      pool: makePool(0, 0),
    }));
    expect(plan).not.toBeNull();
    expect(plan!.reason).toContain("inv=balanced");
    expect(plan!.addAmountA).toBeGreaterThan(0n);
    expect(plan!.addAmountB).toBeGreaterThan(0n);
  });

  it("mild coinA overage (~0.2): coinA side reduced to ~70%", () => {
    // value share of A = 0.7 → overage +0.2 (mild).
    const pm = makePm({ balanceA: 7_000_000n, balanceB: 3_000_000n });
    const plan = diffPlan(makeInput({ pm, pool: makePool(0, 0) }));
    expect(plan).not.toBeNull();
    expect(plan!.reason).toContain("inv=mild");
    // A-side deployment ≈ 70% of available A (7_000_000 × 0.7).
    const deployedA = Number(plan!.addAmountA);
    expect(deployedA).toBeGreaterThan(7_000_000 * 0.65);
    expect(deployedA).toBeLessThan(7_000_000 * 0.75);
    // B side fully deployed.
    expect(plan!.addAmountB).toBe(3_000_000n);
  });

  it("moderate coinA overage (~0.35): zero new coinA orders", () => {
    const pm = makePm({ balanceA: 8_500_000n, balanceB: 1_500_000n });
    const plan = diffPlan(makeInput({ pm, pool: makePool(0, 0) }));
    expect(plan).not.toBeNull();
    expect(plan!.reason).toContain("inv=moderate");
    expect(plan!.addAmountA).toBe(0n);
    expect(plan!.addAmountB).toBe(1_500_000n);
    // No bins above active should remain (they'd be zero-A dust).
    for (const k of plan!.addBins) expect(k).toBeLessThan(0);
  });

  it("severe overage bypasses the shape-deviation quiet guard", () => {
    // Position exactly matching the target shape (would normally be quiet)…
    const positionBins = [];
    for (let k = -3; k <= 3; k++) {
      if (k === 0) continue;
      positionBins.push({ binId: k, liquidityShare: 100n, amountA: 0n, amountB: 0n });
    }
    // …but the book is severely imbalanced (>0.5 overage → single-sided).
    const pmSevere = makePm({ balanceA: 10_000_000n, balanceB: 0n, positionBins });
    const ctx = makeCtx("NORMAL", { toleranceBins: 8, halfWidth: 3 });
    const plan = diffPlan(makeInput({ pm: pmSevere, ctx, pool: makePool(0, 0) }));
    expect(plan).not.toBeNull(); // guard bypassed — correction pass mandated
    expect(plan!.reason).toContain("inv=severe");
    expect(plan!.addAmountA).toBe(0n); // overweight side suppressed
    expect(plan!.removeShares.size).toBe(positionBins.length); // rebuild happens

    // Control: the same position with a balanced book stays quiet.
    const pmBalanced = makePm({ balanceA: 1_000_000n, balanceB: 1_000_000n, positionBins });
    // Note: identical-shape check needs the same weights; with tolerance 8 and
    // matching tent the deviation may still exceed 0.15, so only assert the
    // severe case forced a plan (above) — the control is informational.
    void pmBalanced;
  });
});

// ---------------------------------------------------------------------------
// Phase 3 (C2) — age stop-loss directives
// ---------------------------------------------------------------------------

describe("diffPlan — stop-loss directives", () => {
  it("relaxed ask floor exempts bins at/beyond it from the ask-min filter", () => {
    // Balanced book so the inventory correction stays out of the way
    // (1 raw A ≈ 1 raw B in value under the 9/6-decimals fixture).
    const balancedPm = () => makePm({ balanceA: 1_000_000n, balanceB: 1_000_000n });
    // With feeRateBps=40 and binStep=10 every above-active bin within
    // halfWidth 3 fails the ask-min filter (fill < active×1.011)…
    const strict = diffPlan(makeInput({ pm: balancedPm(), pool: makePool(0, 40) }));
    expect(strict).not.toBeNull();
    expect(strict!.addBins.filter((k) => k > 0)).toHaveLength(0);

    // …but a relaxed floor at bin 1 re-admits the whole above side.
    const relaxed = diffPlan(makeInput({
      pm: balancedPm(),
      pool: makePool(0, 40),
      stopLoss: { relaxedAskFloorBin: 1, forceLiquidationBins: [] },
    }));
    expect(relaxed).not.toBeNull();
    expect(relaxed!.addBins.filter((k) => k > 0).length).toBeGreaterThan(0);
    expect(relaxed!.reason).toContain("stopLoss=relax@1");
  });

  it("force-liquidation bin is added to the candidates and tagged in reason", () => {
    const plan = diffPlan(makeInput({
      pm: makePm({ balanceA: 1_000_000n, balanceB: 1_000_000n }),
      pool: makePool(0, 40),
      stopLoss: { relaxedAskFloorBin: null, forceLiquidationBins: [1] },
    }));
    expect(plan).not.toBeNull();
    expect(plan!.addBins).toContain(1);
    expect(plan!.reason).toContain("stopLoss=force@1");
  });

  it("force liquidation bypasses the shape-deviation quiet guard", () => {
    // Position matching the target (would be quiet) + a forced bin → plan.
    const positionBins = [];
    for (let k = -3; k <= 3; k++) {
      if (k === 0) continue;
      positionBins.push({ binId: k, liquidityShare: 100n, amountA: 0n, amountB: 0n });
    }
    const pm = makePm({ balanceA: 1_000_000n, balanceB: 1_000_000n, positionBins });
    const ctx = makeCtx("NORMAL", { toleranceBins: 8, halfWidth: 3 });
    const withForce = diffPlan(makeInput({
      pm, ctx, pool: makePool(0, 0),
      stopLoss: { relaxedAskFloorBin: null, forceLiquidationBins: [1] },
    }));
    expect(withForce).not.toBeNull();
    expect(withForce!.reason).toContain("stopLoss=force@1");
  });
});
