import type { Strategy, StrategyInput, StrategyOutput } from "./types.ts";

/**
 * P0 single-bin strategy: keep all liquidity in the pool's current active bin.
 * Triggers a recenter whenever the active bin is no longer covered by the open position.
 */
export function createSingleBinStrategy(): Strategy {
  return {
    name: "singleBin",

    async plan({ pm, pool }: StrategyInput): Promise<StrategyOutput> {
      const hasBalance = pm.balance.a > 0n || pm.balance.b > 0n;
      const hasPosition = pm.positionBins.length > 0;
      const hasFees = pm.feeBag.a > 0n || pm.feeBag.b > 0n;

      if (!hasBalance && !hasPosition && !hasFees) {
        return { kind: "quiet", reason: "singleBin: no balance, no position, no fees" };
      }

      // Still in range: any open bin covers the active bin. If fees are in
      // the bag we let the reconciler step deploy them; otherwise nothing to do.
      if (pm.positionBins.some((bin) => bin.binId === pool.activeBinId)) {
        if (hasFees) {
          return { kind: "reconcile_only", reason: "singleBin: in range, fees-only sweep" };
        }
        return { kind: "quiet", reason: "singleBin: in range, no fees" };
      }

      // Out of range (or no position but has balance): drain everything and
      // reenter at the current active bin.
      const removeShares = new Map<number, bigint>();
      for (const bin of pm.positionBins) {
        if (bin.liquidityShare > 0n) {
          removeShares.set(bin.binId, bin.liquidityShare);
        }
      }

      return {
        kind: "plan_and_reconcile",
        plan: {
          pmId: pm.pmId,
          removeShares,
          addAmountA: pm.balance.a,
          addAmountB: pm.balance.b,
          addBins: [pool.activeBinId],
          addAmountsA: [pm.balance.a],
          addAmountsB: [pm.balance.b],
          collectFees: hasFees,
          reason: `singleBin: drift, recenter at active bin ${pool.activeBinId}`,
        },
      };
    },
  };
}
