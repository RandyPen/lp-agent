/**
 * tests/strategies/presenceSweep.test.ts
 *
 * Unit tests for the presenceSweep strategy (presence + cdpm_web fusion):
 *   - sweep-due (no boundary, stable state) → full rebuild + fillBoundary
 *     emitted on the parked side, reason tagged /SWEEP
 *   - valid boundary → frozen bins excluded from removeShares AND adds
 *   - unfreeze-on-fill: a frozen-interval bin the active has crossed is
 *     removable again
 *   - choppy anchor neighbourhood (crossings > 1) → no sweep
 *   - DEFENSE → clearState called + full withdrawal
 *   - quiet when in range with a valid boundary and no fees
 *
 * Persistence is injected (PresenceSweepDeps) — no DB needed.
 */

import { describe, it, expect } from "bun:test";
import { createPresenceSweepStrategy } from "../../src/strategies/presenceSweep.ts";
import type { PositionState } from "../../src/strategies/positionState.ts";
import type { StrategyInput, StrategyOutput } from "../../src/strategies/types.ts";
import type { PMState, PoolState, PriceObservation, RebalancePlan } from "../../src/domain/types.ts";
import type { PoolProfile } from "../../src/pools/types.ts";
import { humanPriceForBin, orientationOf } from "../../src/domain/binMath.ts";
import { emptyLendingState } from "../../src/sui/lending/types.ts";

const ACTIVE = 1445;
const BAR_MS = 60_000;
const T0 = 1_700_000_000_000;

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

// Geometry-consistent spot: the human price AT the active bin, so
// anchorBin ≈ ACTIVE on flat histories.
const P0 = humanPriceForBin(orientationOf(makeProfile()), ACTIVE);

function makePm(opts: {
  balanceA?: bigint;
  balanceB?: bigint;
  feeBagA?: bigint;
  positionBins?: PMState["positionBins"];
} = {}): PMState {
  return {
    pmId: "0xpm",
    owner: "0xowner",
    poolId: "0xpool",
    coinTypeA: "0xusdc::usdc::USDC",
    coinTypeB: "0x2::sui::SUI",
    balance: { a: opts.balanceA ?? 6_500_000n, b: opts.balanceB ?? 4_667_000_000n },
    feeBag: { a: opts.feeBagA ?? 0n, b: 0n },
    positionBins: opts.positionBins ?? [],
    lending: emptyLendingState(),
  };
}

function makePool(activeBinId = ACTIVE): PoolState {
  return { poolId: "0xpool", activeBinId, binStep: 50, feeRateBps: 25 };
}

function historyFromReturns(p0: number, rets: number[]): PriceObservation[] {
  const out: PriceObservation[] = [];
  let p = p0;
  for (let i = 0; i < rets.length; i++) {
    p *= 1 + rets[i]!;
    out.push({ price: p.toFixed(8), timestampMs: T0 + i * BAR_MS, source: "test" });
  }
  return out;
}

function calmReturns(n: number): number[] {
  return Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 0.0001 : -0.0001));
}

/** Steady drift with enough noise to stay under the drift/vol DEFENSE gates. */
function noisyDrift(n: number, totalPct: number): number[] {
  const perBar = Math.pow(1 + totalPct, 1 / n) - 1;
  return Array.from({ length: n }, (_, i) => perBar + (i % 2 === 0 ? 0.0015 : -0.0015));
}

function makeInput(history: PriceObservation[], pm?: PMState, pool?: PoolState): StrategyInput {
  return {
    pm: pm ?? makePm(),
    pool: pool ?? makePool(),
    spot: history[history.length - 1]!,
    history,
    profile: makeProfile(),
  };
}

function expectPlan(output: StrategyOutput): RebalancePlan {
  if (output.kind !== "plan_and_reconcile" && output.kind !== "plan_only") {
    throw new Error(`expected plan, got ${output.kind}: ${JSON.stringify(output, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  }
  return output.plan;
}

function deps(boundary: number | null = null) {
  const calls: string[] = [];
  const loadState = (pmId: string): PositionState | null =>
    boundary === null
      ? null
      : { pmId, fillBoundaryBinId: boundary, strategyName: "presenceSweep", parametersJson: null, updatedAtMs: T0 };
  const clearState = (pmId: string) => { calls.push(pmId); };
  return { loadState, clearState, calls };
}

// ---------------------------------------------------------------------------

describe("presenceSweep sweep + boundary", () => {
  it("declares a 5h history window (anchor + sweep dwell)", () => {
    const s = createPresenceSweepStrategy({}, deps());
    expect(s.historyWindowMs).toBe(5 * 60 * 60 * 1000);
  });

  it("stable LOW state + no boundary → SWEEP: full rebuild, fillBoundary on parked (base) side", async () => {
    // Steady −4% drift: state LOW throughout (crossings=0), boundary absent →
    // sweep due. Parked coin in LOW = base = physical B = bins BELOW active.
    const d = deps(null);
    const s = createPresenceSweepStrategy({}, d);
    const positionBins = [
      { binId: ACTIVE - 3, liquidityShare: 5n, amountA: 0n, amountB: 0n },
      { binId: ACTIVE + 3, liquidityShare: 5n, amountA: 0n, amountB: 0n },
    ];
    const out = await s.plan(
      makeInput(historyFromReturns(P0 / (1 - 0.04), noisyDrift(280, -0.04)), makePm({ positionBins })),
    );
    const plan = expectPlan(out);
    expect(plan.reason).toContain("/SWEEP");
    expect(plan.removeShares.size).toBe(2); // full rebuild removes everything
    if (out.kind === "plan_and_reconcile") {
      expect(out.fillBoundary).toBeDefined();
      expect(out.fillBoundary!).toBeLessThan(ACTIVE); // parked base side = below active
    }
  });

  it("valid boundary → frozen bins excluded from removes and adds", async () => {
    // Flat history: state HIGH (tie), anchorBin≈ACTIVE, boundary above active
    // → frozen interval [ACTIVE..boundary] on the above side.
    const d = deps(ACTIVE + 5);
    const s = createPresenceSweepStrategy({}, d);
    const positionBins = [
      { binId: ACTIVE - 2, liquidityShare: 7n, amountA: 0n, amountB: 0n },  // free
      { binId: ACTIVE + 2, liquidityShare: 9n, amountA: 0n, amountB: 0n },  // frozen
      { binId: ACTIVE + 4, liquidityShare: 11n, amountA: 0n, amountB: 0n }, // frozen
    ];
    // Force a rebalance via fees so quiet gating doesn't shortcut the test.
    const out = await s.plan(
      makeInput(historyFromReturns(P0, calmReturns(301)), makePm({ positionBins, feeBagA: 1_000n })),
    );
    const plan = expectPlan(out);
    expect(plan.reason).not.toContain("/SWEEP");
    expect(plan.removeShares.has(ACTIVE - 2)).toBe(true);
    expect(plan.removeShares.has(ACTIVE + 2)).toBe(false); // frozen kept
    expect(plan.removeShares.has(ACTIVE + 4)).toBe(false); // frozen kept
    expect(plan.addBins).not.toContain(ACTIVE + 2);        // never topped up
    expect(plan.addBins).not.toContain(ACTIVE + 4);
    if (out.kind === "plan_and_reconcile") {
      expect(out.fillBoundary).toBe(ACTIVE + 5);           // boundary re-emitted
    }
  });

  it("unfreeze-on-fill: a frozen bin the active crossed is removable again", async () => {
    // Same boundary, but the pool active moved UP past ACTIVE+2: that bin is
    // now below active → its parked order filled → freeze spent.
    const newActive = ACTIVE + 3;
    const d = deps(ACTIVE + 5);
    const s = createPresenceSweepStrategy({}, d);
    const positionBins = [
      { binId: ACTIVE + 2, liquidityShare: 9n, amountA: 0n, amountB: 0n },  // filled (below new active)
      { binId: ACTIVE + 4, liquidityShare: 11n, amountA: 0n, amountB: 0n }, // still parked (above)
    ];
    const spotAtNewActive = humanPriceForBin(orientationOf(makeProfile()), newActive);
    const out = await s.plan(
      makeInput(
        historyFromReturns(spotAtNewActive, calmReturns(301)),
        makePm({ positionBins, feeBagA: 1_000n }),
        makePool(newActive),
      ),
    );
    const plan = expectPlan(out);
    expect(plan.removeShares.has(ACTIVE + 2)).toBe(true);  // unfrozen: filled
    expect(plan.removeShares.has(ACTIVE + 4)).toBe(false); // still frozen
  });

  it("choppy anchor neighbourhood (crossings > 1) → no sweep, no boundary emitted", async () => {
    // Flat ±0.4% oscillation crosses the anchor repeatedly inside the dwell
    // window → sweep suppressed even without a boundary.
    const rets = Array.from({ length: 300 }, (_, i) => (i % 2 === 0 ? 0.004 : -0.004));
    const d = deps(null);
    const s = createPresenceSweepStrategy({}, d);
    const out = await s.plan(makeInput(historyFromReturns(P0, rets)));
    if (out.kind === "plan_and_reconcile" || out.kind === "plan_only") {
      expect(out.plan.reason).not.toContain("/SWEEP");
      expect(out.kind === "plan_and_reconcile" ? out.fillBoundary : undefined).toBeUndefined();
    }
  });

  it("DEFENSE → clearState called + full withdrawal", async () => {
    const violent = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 0.03 : -0.03));
    const rets = [...calmReturns(270), ...violent];
    const d = deps(ACTIVE + 5);
    const s = createPresenceSweepStrategy({}, d);
    const positionBins = [{ binId: ACTIVE - 3, liquidityShare: 5n, amountA: 0n, amountB: 0n }];
    const out = await s.plan(makeInput(historyFromReturns(P0, rets), makePm({ positionBins })));
    const plan = expectPlan(out);
    expect(plan.addBins.length).toBe(0);
    expect(plan.priority).toBe("emergency");
    expect(d.calls).toContain("0xpm"); // boundary cleared
  });

  it("in range with valid boundary + no fees → quiet", async () => {
    // Free (non-frozen) book must straddle the active bin: 1444 below,
    // 1448 above (outside the frozen interval [anchor..1447]); 1446 frozen.
    const d = deps(ACTIVE + 2);
    const s = createPresenceSweepStrategy({}, d);
    const positionBins = [
      { binId: ACTIVE - 1, liquidityShare: 5n, amountA: 0n, amountB: 0n }, // free below
      { binId: ACTIVE + 1, liquidityShare: 5n, amountA: 0n, amountB: 0n }, // frozen (in interval)
      { binId: ACTIVE + 3, liquidityShare: 5n, amountA: 0n, amountB: 0n }, // free above
    ];
    const out = await s.plan(
      makeInput(historyFromReturns(P0, calmReturns(301)), makePm({ positionBins })),
    );
    expect(out.kind).toBe("quiet");
  });
});
