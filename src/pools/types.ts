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
  /** Fully-qualified type tags. coin_type_a is the "base" token of the pool. */
  coinTypeA: string;
  coinTypeB: string;
  decimalsA: number;
  decimalsB: number;
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
