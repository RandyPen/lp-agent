import type { PoolProfile } from "./types.ts";

/**
 * SUI / USDC profile. Pool ids must be filled in once the deployment target is chosen.
 * The agent will refuse to start with an empty poolId.
 */
export const SUI_USDC: PoolProfile = {
  name: "sui-usdc",
  poolId: process.env.SUI_USDC_POOL_ID ?? "",
  coinTypeA: "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
  coinTypeB: process.env.SUI_USDC_USDC_TYPE ??
    "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
  decimalsA: 9,
  decimalsB: 6,
  binStep: 10,
  pricePairLabel: "SUI/USDC",
  defaultStrategyParams: {
    binWidth: 10,
    expectedFeeBps: 25,
  },
  network: (process.env.SUI_NETWORK as PoolProfile["network"]) ?? "mainnet",
};
