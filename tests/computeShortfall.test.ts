import { describe, it, expect } from "bun:test";
import { computeShortfall } from "../src/services/rebalancer.ts";
import type { PoolProfile } from "../src/pools/types.ts";

const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

function profile(): PoolProfile {
  return {
    name: "test",
    poolId: "0xpool",
    coinTypeA: SUI,
    coinTypeB: USDC,
    decimalsA: 9,
    decimalsB: 6,
    binStep: 10,
    pricePairLabel: "SUI/USDC",
    defaultStrategyParams: { binWidth: 1, expectedFeeBps: 25 },
    lendingPolicy: {
      [SUI]: {
        minIdleBuffer: 100_000_000n,
        supplyThreshold: 500_000_000n,
        redeemHeadroom: 50_000_000n,
        apySwitchDeltaBps: 50,
      },
      [USDC]: {
        minIdleBuffer: 100_000n,
        supplyThreshold: 5_000_000n,
        redeemHeadroom: 500_000n,
        apySwitchDeltaBps: 50,
      },
    },
    network: "mainnet",
  };
}

describe("computeShortfall", () => {
  it("returns 0 when nothing is needed", () => {
    expect(computeShortfall(0n, 1_000_000n, profile(), USDC)).toBe(0n);
  });

  it("returns 0 when idle minus buffer fully covers the need", () => {
    // need 1 USDC, idle 2 USDC, buffer 0.1 USDC → usable 1.9 USDC → no shortfall
    expect(computeShortfall(1_000_000n, 2_000_000n, profile(), USDC)).toBe(0n);
  });

  it("subtracts idle minus buffer from the need when partially covered", () => {
    // need 5 USDC, idle 2 USDC, buffer 0.1 USDC → usable 1.9 USDC → shortfall 3.1 USDC
    expect(computeShortfall(5_000_000n, 2_000_000n, profile(), USDC)).toBe(3_100_000n);
  });

  it("returns the full need when idle is below the buffer", () => {
    // idle below the 0.1 USDC buffer → usable 0 → shortfall = need
    expect(computeShortfall(1_000_000n, 50_000n, profile(), USDC)).toBe(1_000_000n);
  });

  it("returns 0 when the coin type is not in LENDING_OPPORTUNITIES", () => {
    // 用一个不在 lendingConfig 白名单的 coin type — canLend() 应返回 false
    const UNKNOWN_COIN = "0xdeadbeef::unknown::TOKEN";
    expect(computeShortfall(5_000_000n, 1_000_000_000n, profile(), UNKNOWN_COIN)).toBe(0n);
  });

  it("returns 0 when there is no policy entry for the coin", () => {
    const p = profile();
    delete p.lendingPolicy[USDC];
    expect(computeShortfall(5_000_000n, 0n, p, USDC)).toBe(0n);
  });
});
