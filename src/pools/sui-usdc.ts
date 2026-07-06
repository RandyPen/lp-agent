import type { PoolProfile } from "./types.ts";

const SUI_TYPE = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

/**
 * SUI / USDC profile. Built lazily so env vars (`SUI_USDC_POOL_ID`,
 * `SUI_USDC_USDC_TYPE`, `SUI_NETWORK`) can be set after this module loads —
 * required for tests and for callers that change env at runtime.
 *
 * Lendability of SUI and USDC is owned by `src/sui/lending/lendingConfig.ts`
 * (`LENDING_OPPORTUNITIES`), not this file. This profile only carries the
 * per-coin tuning knobs (minIdleBuffer / supplyThreshold / redeemHeadroom /
 * apySwitchDeltaBps) for the coins it cares about.
 */
export function buildSuiUsdcProfile(): PoolProfile {
  const usdcType =
    process.env.SUI_USDC_USDC_TYPE ??
    "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";

  return {
    name: "sui-usdc",
    poolId: process.env.SUI_USDC_POOL_ID ?? "",
    // Agent logical convention: coinA=SUI (base), coinB=USDC (quote).
    // Used for lending routing and PM balance labeling.
    coinTypeA: SUI_TYPE,
    coinTypeB: usdcType,
    decimalsA: 9,
    decimalsB: 6,
    // Physical DLMM pool order: Pool<USDC=6, SUI=9>.
    // Price feeds use these to compute USDC-per-SUI (Binance SUIUSDC convention).
    poolCoinADecimals: 6,
    poolCoinBDecimals: 9,
    // Physical coinA (USDC) is the quote asset → bin price is the inverse of
    // the human SUI/USDC price; bin id ↑ = SUI price ↓. See PoolProfile doc.
    poolCoinAIsQuote: true,
    binStep: 50,
    pricePairLabel: "SUI/USDC",
    defaultStrategyParams: {
      binWidth: 10,
      expectedFeeBps: 25,
    },
    lendingPolicy: {
      [SUI_TYPE]: {
        // 0.1 SUI buffer, 0.5 SUI supply floor, 0.05 SUI redeem headroom.
        minIdleBuffer: 100_000_000n,
        supplyThreshold: 500_000_000n,
        redeemHeadroom: 50_000_000n,
        apySwitchDeltaBps: 50,
      },
      [usdcType]: {
        // 0.1 USDC buffer, 5 USDC supply floor, 0.5 USDC redeem headroom.
        minIdleBuffer: 100_000n,
        supplyThreshold: 5_000_000n,
        redeemHeadroom: 500_000n,
        apySwitchDeltaBps: 50,
      },
    },
    network: (process.env.SUI_NETWORK as PoolProfile["network"]) ?? "mainnet",
  };
}

/**
 * Eagerly-built profile for callers that pinned to the previous shape. Reads
 * env vars at module load — prefer `buildSuiUsdcProfile()` for tests or
 * anywhere env can change at runtime.
 */
export const SUI_USDC: PoolProfile = buildSuiUsdcProfile();
