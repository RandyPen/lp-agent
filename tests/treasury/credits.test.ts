/**
 * Tests for src/treasury/credits.ts — creditsForAmount + estimateRebalanceCost.
 */

import { describe, it, expect } from "bun:test";
import { creditsForAmount, estimateRebalanceCost } from "../../src/treasury/credits.ts";
import type { CreditRate } from "../../src/treasury/types.ts";
import type { RebalancePlan } from "../../src/domain/types.ts";
import type { PoolProfile } from "../../src/pools/types.ts";

const SUI = "0x2::sui::SUI";
const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";

function rate(num: bigint, den: bigint): CreditRate {
  return {
    coinType: USDC,
    rateNum: num,
    rateDen: den,
    updatedAtMs: 0,
    updatedBy: null,
  };
}

describe("creditsForAmount", () => {
  it("USDC at 1 credit = 0.01 USDC: 1 USDC → 100 credits", () => {
    // 1 USDC = 1e6 atomic; rate 1/10000 → 1e6 / 1e4 = 100 credits
    expect(creditsForAmount(1_000_000n, rate(1n, 10000n))).toBe(100);
  });

  it("floor-divides on uneven amounts", () => {
    // 9999 atomic × 1 / 10000 = 0 (floor)
    expect(creditsForAmount(9999n, rate(1n, 10000n))).toBe(0);
    // 10001 atomic × 1 / 10000 = 1 (floor)
    expect(creditsForAmount(10001n, rate(1n, 10000n))).toBe(1);
  });

  it("returns 0 when rate is null (unset coin)", () => {
    expect(creditsForAmount(1_000_000n, null)).toBe(0);
  });

  it("returns 0 for zero / negative deposit amount", () => {
    expect(creditsForAmount(0n, rate(1n, 10000n))).toBe(0);
    expect(creditsForAmount(-1n, rate(1n, 10000n))).toBe(0);
  });

  it("returns 0 when rateDen is 0 (defensive)", () => {
    expect(creditsForAmount(1_000_000n, rate(1n, 0n))).toBe(0);
  });

  it("clamps to MAX_SAFE_INTEGER", () => {
    // 1e30 × 1 / 1 would overflow JS number. Confirm we clamp.
    const huge = 10n ** 30n;
    expect(creditsForAmount(huge, rate(1n, 1n))).toBe(Number.MAX_SAFE_INTEGER);
  });
});

// ---------------------------------------------------------------------------

const SUI_USDC_PROFILE: PoolProfile = {
  name: "sui-usdc",
  poolId: "0xpool",
  coinTypeA: SUI,
  coinTypeB: USDC,
  decimalsA: 9,
  decimalsB: 6,
  binStep: 10,
  pricePairLabel: "SUI/USDC",
  defaultStrategyParams: { binWidth: 1, expectedFeeBps: 40 },
  lendingPolicy: {},
  network: "mainnet",
};

function plan(addA: bigint, addB: bigint): RebalancePlan {
  return {
    pmId: "0xpm",
    removeShares: new Map(),
    addAmountA: addA,
    addAmountB: addB,
    addBins: [-5990],
    addAmountsA: [addA],
    addAmountsB: [addB],
    collectFees: false,
    reason: "test",
  };
}

describe("estimateRebalanceCost", () => {
  const cfg = { rebalanceBaseCost: 10, rebalanceFeeRate: 0.0000001 };
  // spot = 2.5 USDC per SUI

  it("returns just the base cost for a zero-volume plan", () => {
    const cost = estimateRebalanceCost({
      plan: plan(0n, 0n),
      profile: SUI_USDC_PROFILE,
      spotPriceUsdcPerA: 2.5,
      cfg,
    });
    expect(cost).toBe(10);
  });

  it("100 USDC volume + 0 SUI → base 10 + 100×1e6×1e-7 = 10 + 10 = 20 credits", () => {
    const cost = estimateRebalanceCost({
      plan: plan(0n, 100_000_000n), // 100 USDC raw
      profile: SUI_USDC_PROFILE,
      spotPriceUsdcPerA: 2.5,
      cfg,
    });
    expect(cost).toBe(20);
  });

  it("1000 USDC volume → 110 credits", () => {
    const cost = estimateRebalanceCost({
      plan: plan(0n, 1_000_000_000n),
      profile: SUI_USDC_PROFILE,
      spotPriceUsdcPerA: 2.5,
      cfg,
    });
    expect(cost).toBe(110);
  });

  it("SUI side is converted via spot price", () => {
    // 1 SUI = 1e9 atomic, × 2.5 USDC × 10^(6-9) = 1e9 × 2.5 × 1e-3 = 2.5e6 USDC atomic
    // variable = 2.5e6 × 1e-7 = 0.25 credit → floor → 0
    // total = base 10 + 0 = 10
    const cost = estimateRebalanceCost({
      plan: plan(1_000_000_000n, 0n),
      profile: SUI_USDC_PROFILE,
      spotPriceUsdcPerA: 2.5,
      cfg,
    });
    expect(cost).toBe(10);
  });

  it("never returns negative", () => {
    const cost = estimateRebalanceCost({
      plan: plan(0n, 0n),
      profile: SUI_USDC_PROFILE,
      spotPriceUsdcPerA: 2.5,
      cfg: { rebalanceBaseCost: 0, rebalanceFeeRate: 0 },
    });
    expect(cost).toBe(0);
  });
});
