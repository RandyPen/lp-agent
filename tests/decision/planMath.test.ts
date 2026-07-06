/**
 * tests/decision/planMath.test.ts — rescalePlanToAvailable.
 */

import { describe, it, expect } from "bun:test";
import { rescalePlanToAvailable } from "../../src/decision/planMath.ts";
import type { RebalancePlan } from "../../src/domain/types.ts";

function makePlan(overrides: Partial<RebalancePlan> = {}): RebalancePlan {
  return {
    pmId: "0xpm",
    removeShares: new Map(),
    addAmountA: 1_000n,
    addAmountB: 2_000n,
    addBins: [10, 12],
    addAmountsA: [1_000n, 0n],
    addAmountsB: [0n, 2_000n],
    collectFees: false,
    reason: "test",
    ...overrides,
  };
}

describe("rescalePlanToAvailable", () => {
  it("returns the same object when totals already match", () => {
    const plan = makePlan();
    expect(rescalePlanToAvailable(plan, 1_000n, 2_000n)).toBe(plan);
  });

  it("scales a side UP proportionally, preserving shape", () => {
    const plan = makePlan({
      addBins: [11, 12, 13],
      addAmountsA: [100n, 300n, 600n],
      addAmountsB: [0n, 0n, 0n],
      addAmountA: 1_000n,
      addAmountB: 0n,
    });
    const out = rescalePlanToAvailable(plan, 10_000n, 0n);
    expect(out.addAmountA).toBe(10_000n);
    expect(out.addAmountsA).toEqual([1_000n, 3_000n, 6_000n]);
    expect(out.reason).toContain("[rescaled]");
  });

  it("scales a side DOWN proportionally", () => {
    const plan = makePlan({
      addBins: [11, 12],
      addAmountsA: [600n, 400n],
      addAmountsB: [0n, 0n],
      addAmountA: 1_000n,
      addAmountB: 0n,
    });
    const out = rescalePlanToAvailable(plan, 500n, 0n, 1n);
    expect(out.addAmountA).toBe(500n);
    expect(out.addAmountsA).toEqual([300n, 200n]);
  });

  it("assigns rounding dust to the largest bin so the sum is exact", () => {
    const plan = makePlan({
      addBins: [11, 12, 13],
      addAmountsA: [1n, 1n, 2n],
      addAmountsB: [0n, 0n, 0n],
      addAmountA: 4n,
      addAmountB: 0n,
    });
    // 1001/4 doesn't divide evenly; dust must land on the largest bin (idx 2).
    const out = rescalePlanToAvailable(plan, 1_001n, 0n, 1n);
    expect(out.addAmountA).toBe(1_001n);
    expect(out.addAmountsA.reduce((s, v) => s + v, 0n)).toBe(1_001n);
    const maxOut = out.addAmountsA[2]!;
    expect(maxOut).toBeGreaterThanOrEqual(out.addAmountsA[0]!);
    expect(maxOut).toBeGreaterThanOrEqual(out.addAmountsA[1]!);
  });

  it("a zero-planned side stays all-zero (no shape to scale)", () => {
    const plan = makePlan({
      addBins: [11, 12],
      addAmountsA: [500n, 500n],
      addAmountsB: [0n, 0n],
      addAmountA: 1_000n,
      addAmountB: 0n,
    });
    const out = rescalePlanToAvailable(plan, 1_000n, 999_999n);
    expect(out.addAmountB).toBe(0n);
    expect(out.addAmountsB.every((v) => v === 0n)).toBe(true);
  });

  it("drops bins where both sides fall below minBinAmount", () => {
    const plan = makePlan({
      addBins: [11, 12],
      addAmountsA: [1n, 9_999n],
      addAmountsB: [0n, 0n],
      addAmountA: 10_000n,
      addAmountB: 0n,
    });
    // Scale down 100×: bin 11 → 0n (dust), bin 12 → ~100n.
    const out = rescalePlanToAvailable(plan, 100n, 0n, 10n);
    expect(out.addBins).toEqual([12]);
    expect(out.addAmountA).toBe(out.addAmountsA.reduce((s, v) => s + v, 0n));
  });

  it("removeShares / collectFees pass through untouched", () => {
    const removeShares = new Map([[5, 42n]]);
    const plan = makePlan({ removeShares, collectFees: true });
    const out = rescalePlanToAvailable(plan, 5_000n, 5_000n);
    expect(out.removeShares).toBe(removeShares);
    expect(out.collectFees).toBe(true);
  });

  it("throws on negative available", () => {
    expect(() => rescalePlanToAvailable(makePlan(), -1n, 0n)).toThrow(RangeError);
  });
});
