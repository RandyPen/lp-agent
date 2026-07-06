import type { LendingCoinPolicy } from "../strategies/lendingPolicy.ts";

/**
 * Pool-specific configuration. v0 ships only one of these (sui-usdc).
 * Forking to a new asset = add a new file in this directory and switch POOL_PROFILE.
 * No code outside src/pools/*.ts may reference asset-specific constants.
 */
export interface PoolProfile {
  /** Logical name (matches POOL_PROFILE env var). */
  name: string;
  /** DLMM pool object id on the active network. */
  poolId: string;
  /**
   * Fully-qualified type tags.
   *
   * NOTE: `coinTypeA` / `coinTypeB` reflect the agent's logical convention (used for
   * lending routing and balance labeling), NOT necessarily the DLMM pool's physical
   * coin order. The physical pool order matters only for price math — use
   * `poolCoinADecimals` / `poolCoinBDecimals` when it differs from `decimalsA` / `decimalsB`.
   */
  coinTypeA: string;
  coinTypeB: string;
  decimalsA: number;
  decimalsB: number;
  /**
   * Physical coin decimals as stored in the DLMM pool object (Pool<coinA, coinB>).
   * Present only when the pool's physical coin order differs from the agent's logical
   * convention above.
   *
   * For the SUI/USDC mainnet pool: Pool<USDC=6, SUI=9>, so `poolCoinADecimals=6`,
   * `poolCoinBDecimals=9`. Price feeds use these to compute the human price in the
   * Binance SUIUSDC convention (USDC per SUI).
   *
   * When absent, price feeds fall back to `decimalsA` / `decimalsB`.
   */
  poolCoinADecimals?: number;
  poolCoinBDecimals?: number;
  /**
   * True when the pool's PHYSICAL coinA is the QUOTE asset of the pair —
   * i.e. the DLMM bin price (physical B-per-A) is the INVERSE of the human
   * pair price. For the mainnet SUI/USDC pool (Pool<USDC, SUI>, label
   * "SUI/USDC") this is true: bin id ↑ = SUI-per-USDC ↑ = USDC-per-SUI ↓.
   *
   * Verified empirically (scripts/probe-bin-orientation.ts): bins ABOVE the
   * active bin hold physical coinA only, bins BELOW hold physical coinB only.
   * With poolCoinAIsQuote=true that means above-active = quote = bids and
   * below-active = base = asks.
   *
   * Default (absent) = false: physical order matches the logical convention.
   */
  poolCoinAIsQuote?: boolean;
  /** Bin step in basis points (1 = 0.01%). Verified at runtime against on-chain pool. */
  binStep: number;
  /** Used to look up external prices (e.g. "SUI/USDC"). */
  pricePairLabel: string;
  /** Default strategy parameters; strategies are free to override. */
  defaultStrategyParams: {
    /** Number of bins to spread liquidity over (single-bin strategy may ignore). */
    binWidth: number;
    /** Hint for fee modeling: typical pool fee in bps. Read from pool at runtime; this is a fallback. */
    expectedFeeBps: number;
  };
  /**
   * Per-coin lending policy keyed by coin type tag (tuning knobs:
   * minIdleBuffer / supplyThreshold / redeemHeadroom / apySwitchDeltaBps).
   *
   * **Lendability** (whether a coin can be lent at all) is **NOT** owned by
   * the pool profile any more — see `src/sui/lending/lendingConfig.ts`
   * (`LENDING_OPPORTUNITIES` + `canLend(coinType)`). The pool profile only
   * carries the per-coin tuning knobs for the coins it cares about.
   * Entries here for coins NOT in `LENDING_OPPORTUNITIES` are simply unused.
   */
  lendingPolicy: Record<string, LendingCoinPolicy>;
  /** Network this profile targets. */
  network: "mainnet" | "testnet" | "devnet";
}
