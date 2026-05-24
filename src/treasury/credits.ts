/**
 * Credit math.
 *
 * Two formulas:
 *
 *   1. **Deposit → credits** (watcher):
 *        credits = floor(amount_atomic × rate_num / rate_den)
 *      Per-coin rates live in `treasury_credit_rates`. When a coin has no
 *      rate set, `creditsForAmount` returns 0 — the deposit row is still
 *      recorded (audit trail) and operator backfills via script later.
 *
 *   2. **Rebalance → cost** (rebalancer):
 *        cost_credits = base + volume_usdc_atomic × fee_rate
 *      `volume_usdc_atomic` = sum of plan.addAmountA + plan.addAmountB,
 *      both folded to USDC raw atomic (6 decimals). A-side conversion uses
 *      the spot price; B-side is assumed already USDC-stable (true for the
 *      sui-usdc pool; future pools should set `usdcStableSide` on
 *      PoolProfile when this generalises).
 *      Result is `Math.floor`'d to integer credits. base + variable both
 *      floor; users always benefit on rounding.
 */

import type { PoolProfile } from "../pools/types.ts";
import type { RebalancePlan } from "../domain/types.ts";
import type { TreasuryAppConfig } from "../config.ts";
import type { CreditRate } from "./types.ts";

/**
 * Convert an on-chain delta (raw atomic units) to credits using the given
 * rate. Returns 0 when rate is null or yields < 1 credit (dust).
 */
export function creditsForAmount(
  amountAtomic: bigint,
  rate: CreditRate | null,
): number {
  if (rate === null) return 0;
  if (amountAtomic <= 0n) return 0;
  if (rate.rateDen <= 0n) return 0;
  const raw = (amountAtomic * rate.rateNum) / rate.rateDen; // bigint floor
  // Clamp to JS-safe integer; credit balances should never approach 2^53 in
  // realistic operation but defend anyway.
  const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
  const clamped = raw > MAX_SAFE ? MAX_SAFE : raw;
  return Number(clamped);
}

/**
 * Estimate the cost (credits) of executing a rebalance plan.
 *
 * Pool-shape assumption: B-side is USDC stable (true for sui-usdc).
 * For multi-pool deployments where B ≠ USDC, extend `PoolProfile` with
 * a `usdcStableSide: 'A' | 'B'` discriminator and switch the math here.
 *
 * Precision caveat: `Number(plan.addAmountA)` loses precision when SUI
 * atomic > 9e15 (~ 9M SUI). Per-PM volumes in v1 are far below this; if
 * a giant PM appears, refactor to bigint-throughout.
 */
export function estimateRebalanceCost(args: {
  plan: RebalancePlan;
  profile: PoolProfile;
  spotPriceUsdcPerA: number;
  cfg: Pick<TreasuryAppConfig, "rebalanceBaseCost" | "rebalanceFeeRate">;
}): number {
  const { plan, profile, spotPriceUsdcPerA, cfg } = args;
  // A → USDC atomic: aAtomic × spot × 10^(decimalsB − decimalsA)
  const aUsdcAtomic =
    Number(plan.addAmountA) *
    spotPriceUsdcPerA *
    Math.pow(10, profile.decimalsB - profile.decimalsA);
  const bUsdcAtomic = Number(plan.addAmountB);
  const volumeUsdcAtomic = aUsdcAtomic + bUsdcAtomic;
  const variable = volumeUsdcAtomic * cfg.rebalanceFeeRate;
  const total = cfg.rebalanceBaseCost + variable;
  return Math.max(0, Math.floor(total));
}
