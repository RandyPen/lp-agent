/**
 * The plan validator is the framework's defence against a strategy it did not
 * write. These tests pin that it catches the exact bug class this repo once
 * shipped unnoticed (an inverted side-split), and that every BUILT-IN strategy
 * satisfies the invariants it enforces.
 */

import { describe, it, expect } from "bun:test";
import { validatePlan } from "../../src/decision/planInvariants.ts";
import { createSingleBinStrategy } from "../../src/strategies/singleBin.ts";
import { createMultiBinSpotStrategy } from "../../src/strategies/multiBinSpot.ts";
import { createPresenceAnchorStrategy } from "../../src/strategies/presenceAnchor.ts";
import { createPresenceSweepStrategy } from "../../src/strategies/presenceSweep.ts";
import type { RebalancePlan } from "../../src/domain/types.ts";
import {
  makeTestProfile,
  makeInput,
  assertPlanInvariants,
  BASE_ACTIVE_BIN,
} from "./index.ts";

const profile = makeTestProfile();
const ACTIVE = BASE_ACTIVE_BIN;

function basePlan(overrides: Partial<RebalancePlan> = {}): RebalancePlan {
  return {
    pmId: "0xpm",
    removeShares: new Map(),
    addAmountA: 0n,
    addAmountB: 0n,
    addBins: [],
    addAmountsA: [],
    addAmountsB: [],
    collectFees: false,
    reason: "test",
    plannedActiveBinId: ACTIVE,
    ...overrides,
  };
}

describe("validatePlan", () => {
  it("accepts a correct plan: coinA above active, coinB below", () => {
    const plan = basePlan({
      addBins: [ACTIVE - 1, ACTIVE + 1],
      addAmountsA: [0n, 100n],
      addAmountsB: [200n, 0n],
      addAmountA: 100n,
      addAmountB: 200n,
    });
    expect(validatePlan(plan, profile, ACTIVE)).toHaveLength(0);
  });

  it("catches THE bug: an inverted side-split (coinB above, coinA below)", () => {
    // This is what shipped once. Every amount is positive, the sums are right,
    // the bins are sane — and the liquidity lands on the wrong side of the market.
    const plan = basePlan({
      addBins: [ACTIVE - 1, ACTIVE + 1],
      addAmountsA: [100n, 0n], // coinA BELOW  ← wrong
      addAmountsB: [0n, 200n], // coinB ABOVE  ← wrong
      addAmountA: 100n,
      addAmountB: 200n,
    });

    const v = validatePlan(plan, profile, ACTIVE);
    expect(v).toHaveLength(2);
    expect(v.every((x) => x.code === "side_rule_violation")).toBe(true);
  });

  it("rejects placement ON the active bin (composition fee policy)", () => {
    const plan = basePlan({
      addBins: [ACTIVE],
      addAmountsA: [100n],
      addAmountsB: [0n],
      addAmountA: 100n,
      addAmountB: 0n,
    });

    const v = validatePlan(plan, profile, ACTIVE);
    expect(v.map((x) => x.code)).toContain("active_bin_placement");
  });

  it("catches per-bin amounts that don't sum to the declared totals", () => {
    // The executor funds the PTB from addAmountA/addAmountB. If Σ per-bin
    // exceeds that, coin.split aborts the whole PTB on-chain.
    const plan = basePlan({
      addBins: [ACTIVE + 1],
      addAmountsA: [100n],
      addAmountsB: [0n],
      addAmountA: 999n, // ← lie
      addAmountB: 0n,
    });

    const v = validatePlan(plan, profile, ACTIVE);
    expect(v.map((x) => x.code)).toContain("amount_sum_mismatch");
  });

  it("catches ragged parallel arrays without cascading", () => {
    const plan = basePlan({
      addBins: [ACTIVE + 1, ACTIVE + 2],
      addAmountsA: [100n], // ← short
      addAmountsB: [0n, 0n],
    });

    const v = validatePlan(plan, profile, ACTIVE);
    expect(v).toHaveLength(1);
    expect(v[0]!.code).toBe("array_length_mismatch");
  });

  it("catches negative amounts", () => {
    const plan = basePlan({
      addBins: [ACTIVE + 1],
      addAmountsA: [-5n],
      addAmountsB: [0n],
      addAmountA: -5n,
      addAmountB: 0n,
    });

    expect(validatePlan(plan, profile, ACTIVE).map((x) => x.code)).toContain("negative_amount");
  });
});

describe("every built-in strategy produces physically valid plans", () => {
  const strategies = [
    createSingleBinStrategy(),
    createMultiBinSpotStrategy(),
    createPresenceAnchorStrategy(),
    createPresenceSweepStrategy(),
  ];

  for (const strategy of strategies) {
    it(`${strategy.name}: fresh deploy`, async () => {
      const out = await strategy.plan(makeInput({ activeBin: ACTIVE }));
      assertPlanInvariants(out, profile, ACTIVE);
    });

    it(`${strategy.name}: recenter after drift (positionValue injected)`, async () => {
      const out = await strategy.plan(
        makeInput({
          activeBin: ACTIVE + 8, // drifted far out of range
          positionBins: [
            { binId: ACTIVE - 1, amountA: 0n, amountB: 1_000_000_000n, liquidityShare: 1_000_000_000n },
            { binId: ACTIVE + 1, amountA: 2_000_000n, amountB: 0n, liquidityShare: 2_000_000n },
          ],
          balanceA: 0n,
          balanceB: 0n,
          positionValue: { a: 2_000_000n, b: 1_000_000_000n },
        }),
      );
      assertPlanInvariants(out, profile, ACTIVE + 8);
    });
  }
});
