import type { Strategy, StrategyInput } from "./types.ts";
import type { RebalancePlan } from "../domain/types.ts";

/**
 * P0 single-bin strategy: keep all liquidity in the pool's current active bin.
 * Triggers a recenter whenever the active bin is no longer covered by the open position.
 */
export function createSingleBinStrategy(): Strategy {
  return {
    name: "singleBin",

    plan({ pm, pool }: StrategyInput): RebalancePlan | null {
      // Nothing to do if no balance and no position.
      if (
        pm.balance.a === 0n &&
        pm.balance.b === 0n &&
        pm.positionBins.length === 0
      ) {
        return null;
      }

      // Still in range: any open bin covers the active bin.
      if (pm.positionBins.some((bin) => bin.binId === pool.activeBinId)) {
        return null;
      }

      // Out of range (or no position but has balance): drain everything and
      // reenter at the current active bin.
      const removeShares = new Map<number, bigint>();
      for (const bin of pm.positionBins) {
        if (bin.liquidityShare > 0n) {
          removeShares.set(bin.binId, bin.liquidityShare);
        }
      }

      // Collect fees before rebalancing if there is anything in the fee bag.
      const collectFees = pm.feeBag.a > 0n || pm.feeBag.b > 0n;

      return {
        pmId: pm.pmId,
        removeShares,
        addAmountA: pm.balance.a,
        addAmountB: pm.balance.b,
        addBins: [pool.activeBinId],
        addAmountsA: [pm.balance.a],
        addAmountsB: [pm.balance.b],
        collectFees,
        reason: `singleBin: drift, recenter at active bin ${pool.activeBinId}`,
      };
    },
  };
}
