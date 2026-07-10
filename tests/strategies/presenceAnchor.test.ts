/**
 * tests/strategies/presenceAnchor.test.ts
 *
 * Unit tests for the presenceAnchor strategy (presence architecture):
 *   - plan invariants (never the active bin, physical side rule, sums)
 *   - calm history → NORMAL, centered on active
 *   - price stretched above the 4h anchor → center pulled toward the anchor,
 *     with the correct sign for the INVERTED SUI/USDC pool (human −offset →
 *     bin +offset)
 *   - vol spike → DEFENSE: full withdrawal, no adds, lendingPct = 1
 *   - re-entry hysteresis: recent spike blocks redeployment; an old spike
 *     doesn't
 *   - inventory steering vs targetBaseShare: overweight base zeroes the bid
 *     side, underweight base zeroes the ask side
 *   - TREND: only trendCapitalScale of capital deployed
 *   - quiet when in range; cold start produces a plan without throwing
 */

import { describe, it, expect } from "bun:test";
import { createPresenceAnchorStrategy } from "../../src/strategies/presenceAnchor.ts";
import type { StrategyInput, StrategyOutput } from "../../src/strategies/types.ts";
import type { PMState, PoolState, PriceObservation, RebalancePlan } from "../../src/domain/types.ts";
import type { PoolProfile } from "../../src/pools/types.ts";
import { emptyLendingState } from "../../src/sui/lending/types.ts";

const ACTIVE = 1445;
const BAR_MS = 60_000;
const T0 = 1_700_000_000_000;

/** SUI/USDC-shaped profile: physical Pool<USDC=6, SUI=9>, inverted. */
function makeProfile(): PoolProfile {
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
  };
}

function makePm(opts: {
  balanceA?: bigint;
  balanceB?: bigint;
  feeBagA?: bigint;
  feeBagB?: bigint;
  positionBins?: PMState["positionBins"];
} = {}): PMState {
  return {
    pmId: "0xpm",
    owner: "0xowner",
    poolId: "0xpool",
    coinTypeA: "0xusdc::usdc::USDC", // physical A
    coinTypeB: "0x2::sui::SUI",      // physical B
    // Default ≈ balanced at spot 0.75 vs targetBaseShare 0.35:
    //   quote (A/USDC, 6dp) = 6.5;  base (B/SUI, 9dp) = 4.667 → value 3.5
    balance: { a: opts.balanceA ?? 6_500_000n, b: opts.balanceB ?? 4_667_000_000n },
    feeBag: { a: opts.feeBagA ?? 0n, b: opts.feeBagB ?? 0n },
    positionBins: opts.positionBins ?? [],
    lending: emptyLendingState(),
  };
}

function makePool(): PoolState {
  return { poolId: "0xpool", activeBinId: ACTIVE, binStep: 50, feeRateBps: 25 };
}

/** Build a 1m-spaced history from per-bar multiplicative returns. */
function historyFromReturns(p0: number, rets: number[]): PriceObservation[] {
  const out: PriceObservation[] = [];
  let p = p0;
  for (let i = 0; i < rets.length; i++) {
    p *= 1 + rets[i]!;
    out.push({ price: p.toFixed(8), timestampMs: T0 + i * BAR_MS, source: "test" });
  }
  return out;
}

/** n calm bars: alternating tiny ±1bp returns (non-zero σ, flat mean). */
function calmReturns(n: number): number[] {
  return Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 0.0001 : -0.0001));
}

/** n violent bars: alternating ±3% (flat mean, huge σ). */
function violentReturns(n: number): number[] {
  return Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 0.03 : -0.03));
}

function makeInput(history: PriceObservation[], pm?: PMState): StrategyInput {
  return {
    pm: pm ?? makePm(),
    pool: makePool(),
    spot: history[history.length - 1]!,
    history,
    profile: makeProfile(),
  };
}

function expectPlan(output: StrategyOutput): RebalancePlan {
  if (output.kind !== "plan_and_reconcile" && output.kind !== "plan_only") {
    throw new Error(`expected a plan output, got ${output.kind}: ${JSON.stringify(output, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  }
  return output.plan;
}

function assertPlanInvariants(plan: RebalancePlan): void {
  expect(plan.addBins).not.toContain(ACTIVE);
  expect(plan.addBins.length).toBe(plan.addAmountsA.length);
  expect(plan.addBins.length).toBe(plan.addAmountsB.length);
  for (let i = 0; i < plan.addBins.length; i++) {
    const bin = plan.addBins[i]!;
    if (bin > ACTIVE) expect(plan.addAmountsB[i]!).toBe(0n);
    else expect(plan.addAmountsA[i]!).toBe(0n);
  }
  expect(plan.addAmountsA.reduce((s, v) => s + v, 0n)).toBe(plan.addAmountA);
  expect(plan.addAmountsB.reduce((s, v) => s + v, 0n)).toBe(plan.addAmountB);
  expect(plan.plannedActiveBinId).toBe(ACTIVE);
}

const strategy = createPresenceAnchorStrategy();

// ---------------------------------------------------------------------------
// NORMAL regime
// ---------------------------------------------------------------------------

describe("presenceAnchor NORMAL", () => {
  it("declares a 4h history window requirement", () => {
    expect(strategy.historyWindowMs).toBe(4 * 60 * 60 * 1000);
  });

  it("empty PM → quiet", async () => {
    const out = await strategy.plan(
      makeInput(historyFromReturns(0.75, calmReturns(240)), makePm({ balanceA: 0n, balanceB: 0n })),
    );
    expect(out.kind).toBe("quiet");
  });

  it("calm history → NORMAL plan centered on active, invariants hold", async () => {
    const out = await strategy.plan(makeInput(historyFromReturns(0.75, calmReturns(240))));
    const plan = expectPlan(out);
    assertPlanInvariants(plan);
    // dev ≈ 0 → target center = active; stateCtx carries the NORMAL lending target
    expect(plan.reason).toContain("NORMAL");
    expect(plan.reason).toContain(`center=${ACTIVE}`);
    if (out.kind === "plan_and_reconcile") {
      expect(out.stateCtx?.state).toBe("NORMAL");
      expect(out.stateCtx?.lendingPct).toBeCloseTo(0.35, 5);
    }
  });

  it("price stretched above the anchor → center pulled toward the anchor (bin id UP on the inverted pool)", async () => {
    // Steady exponential drift: +4% over 4h. σ_short ≈ σ_long → NORMAL;
    // spot ends ≈ 2% above the window mean → dev ≈ +4 bins (binStep 50bp) →
    // human offset −2 → physical bin offset +2 on the inverted pool.
    const perBar = Math.pow(1.04, 1 / 240) - 1;
    const rets = Array.from({ length: 240 }, () => perBar);
    const out = await strategy.plan(makeInput(historyFromReturns(0.7212, rets)));
    const plan = expectPlan(out);
    assertPlanInvariants(plan);
    expect(plan.reason).toContain(`center=${ACTIVE + 2}`);
    // Placement mass sits above the active bin (quote-side bids that buy the
    // reversion back down to the anchor).
    const massAbove = plan.addBins.filter((b) => b > ACTIVE).length;
    expect(massAbove).toBeGreaterThan(0);
  });

  it("in range + no fees → quiet", async () => {
    const positionBins = [
      { binId: ACTIVE - 2, liquidityShare: 5n, amountA: 0n, amountB: 0n },
      { binId: ACTIVE + 2, liquidityShare: 5n, amountA: 0n, amountB: 0n },
    ];
    const out = await strategy.plan(
      makeInput(historyFromReturns(0.75, calmReturns(240)), makePm({ positionBins })),
    );
    expect(out.kind).toBe("quiet");
  });

  it("cold start (<60min history) → still produces a plan, labeled cold-start", async () => {
    const out = await strategy.plan(makeInput(historyFromReturns(0.75, calmReturns(10))));
    const plan = expectPlan(out);
    assertPlanInvariants(plan);
    expect(plan.reason).toContain("cold-start");
    expect(plan.reason).toContain(`center=${ACTIVE}`); // reversion off in cold start
  });
});

// ---------------------------------------------------------------------------
// Inventory steering
// ---------------------------------------------------------------------------

describe("presenceAnchor inventory steering", () => {
  it("base (SUI) overweight → bid side (physical A above active) fully held back", async () => {
    // base value 75 vs quote 1 → baseShare ≈ 0.99 → err ≥ +0.25 → bid frac 0.
    const pm = makePm({ balanceA: 1_000_000n, balanceB: 100_000_000_000n });
    const out = await strategy.plan(makeInput(historyFromReturns(0.75, calmReturns(240)), pm));
    const plan = expectPlan(out);
    assertPlanInvariants(plan);
    expect(plan.addAmountA).toBe(0n);       // no quote deployed to buy MORE base
    expect(plan.addAmountB).toBeGreaterThan(0n); // base sells (asks) fully deployed
  });

  it("base underweight → ask side (physical B below active) fully held back", async () => {
    // base value ≈ 0.075 vs quote 100 → baseShare ≈ 0 → err ≤ −0.25 → ask frac 0.
    const pm = makePm({ balanceA: 100_000_000n, balanceB: 100_000_000n });
    const out = await strategy.plan(makeInput(historyFromReturns(0.75, calmReturns(240)), pm));
    const plan = expectPlan(out);
    assertPlanInvariants(plan);
    expect(plan.addAmountB).toBe(0n);       // scarce base is not sold
    expect(plan.addAmountA).toBeGreaterThan(0n);
  });
});

// ---------------------------------------------------------------------------
// TREND regime
// ---------------------------------------------------------------------------

describe("presenceAnchor TREND", () => {
  it("mid vol ratio → TREND, only half the capital deployed", async () => {
    // Sustained MODERATE vol for the last 100 bars (±1.2%): every rolling
    // short-σ reading in the trailing 30min sits at √(240/100) ≈ 1.55 —
    // inside [1.3, 1.7) at all scan points, so TREND without the DEFENSE
    // hysteresis tripping.
    const moderate = Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? 0.012 : -0.012));
    const rets = [...calmReturns(140), ...moderate];
    const out = await strategy.plan(makeInput(historyFromReturns(0.75, rets)));
    const plan = expectPlan(out);
    assertPlanInvariants(plan);
    expect(plan.reason).toContain("TREND");
    // capitalScale 0.5: deployed A ≤ half of gross A (6.5 USDC → ≤ 3.25).
    expect(plan.addAmountA).toBeLessThanOrEqual(3_250_000n);
    expect(plan.addAmountA).toBeGreaterThan(0n);
    if (out.kind === "plan_and_reconcile") {
      expect(out.stateCtx?.state).toBe("TREND");
      expect(out.stateCtx?.lendingPct).toBeCloseTo(0.6, 5);
    }
  });
});

// ---------------------------------------------------------------------------
// DEFENSE regime (presence-only exit)
// ---------------------------------------------------------------------------

describe("presenceAnchor DEFENSE", () => {
  const spikeNow = [...calmReturns(210), ...violentReturns(30)];

  it("fresh vol spike → full withdrawal, no adds, lendingPct = 1", async () => {
    const positionBins = [
      { binId: ACTIVE - 3, liquidityShare: 11n, amountA: 0n, amountB: 0n },
      { binId: ACTIVE + 2, liquidityShare: 22n, amountA: 0n, amountB: 0n },
    ];
    const out = await strategy.plan(
      makeInput(historyFromReturns(0.75, spikeNow), makePm({ positionBins })),
    );
    const plan = expectPlan(out);
    expect(plan.addBins.length).toBe(0);
    expect(plan.removeShares.get(ACTIVE - 3)).toBe(11n);
    expect(plan.removeShares.get(ACTIVE + 2)).toBe(22n);
    expect(plan.priority).toBe("emergency");
    if (out.kind === "plan_and_reconcile") {
      expect(out.stateCtx?.state).toBe("EXTREME");
      expect(out.stateCtx?.lendingPct).toBe(1.0);
    }
  });

  it("fresh vol spike + nothing on the book → reconcile_only (idle swept to lending)", async () => {
    const out = await strategy.plan(makeInput(historyFromReturns(0.75, spikeNow)));
    expect(out.kind).toBe("reconcile_only");
    if (out.kind === "reconcile_only") {
      expect(out.stateCtx?.lendingPct).toBe(1.0);
    }
  });

  it("spike ended recently (re-entry window not yet calm) → still DEFENSE", async () => {
    // Violent bars 150..209, then only 30 calm bars. The CURRENT ratio has
    // already receded (≈1.4 < 1.7) but rolling short-σ readings in the
    // trailing 30min still contain the burst (up to ≈1.9) → re-entry blocked;
    // DEFENSE is held purely by the hysteresis.
    const rets = [...calmReturns(150), ...violentReturns(60), ...calmReturns(30)];
    const out = await strategy.plan(makeInput(historyFromReturns(0.75, rets)));
    expect(out.kind).toBe("reconcile_only"); // no position → hold in lending
    if (out.kind === "reconcile_only") {
      expect(out.reason).toContain("DEFENSE");
      expect(out.reason).toContain("re-entry blocked");
    }
  });

  it("spike aged out (calm long enough) → redeploys", async () => {
    // Violent bars 80..139, then 100 calm bars: every rolling short-σ reading
    // in the trailing 30min is burst-free → NORMAL again.
    const rets = [...calmReturns(80), ...violentReturns(60), ...calmReturns(100)];
    const out = await strategy.plan(makeInput(historyFromReturns(0.75, rets)));
    const plan = expectPlan(out);
    assertPlanInvariants(plan);
    expect(plan.reason).toContain("NORMAL");
  });
});
