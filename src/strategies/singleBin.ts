import type { Strategy, StrategyInput, StrategyOutput } from "./types.ts";

/**
 * P0 straddle strategy (formerly "single-bin"): hold liquidity in the two
 * bins immediately ADJACENT to the pool's active bin — `active−1` and
 * `active+1` — never on the active bin itself.
 *
 * SEMANTICS CHANGE (Phase 2 active-bin policy): the original design placed
 * everything ON the active bin. Active-bin adds are accepted by the chain but
 * charged a composition fee whenever the add ratio differs from the bin's
 * internal ratio; project policy (decision-engine-design §1.3) is to never
 * place there. The tightest compliant shape is this 2-bin straddle.
 *
 * Coin sides follow the PHYSICAL rule (verified on mainnet,
 * scripts/probe-bin-orientation.ts):
 *   - bin `active+1` (above) holds physical coinA only
 *   - bin `active−1` (below) holds physical coinB only
 *
 * Triggers:
 *   - No position + capital → deploy the straddle.
 *   - Active bin outside the position's [lowest, highest] range → recenter.
 *   - In range + fees → reconcile-only sweep.
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

      // In range: the position straddles the active bin (lowest ≤ active ≤
      // highest). If fees are in the bag we let the reconciler deploy them;
      // otherwise nothing to do.
      if (hasPosition) {
        const lowest = pm.positionBins.reduce(
          (m, b) => Math.min(m, b.binId),
          pm.positionBins[0]!.binId,
        );
        const highest = pm.positionBins.reduce(
          (m, b) => Math.max(m, b.binId),
          pm.positionBins[0]!.binId,
        );
        if (lowest <= pool.activeBinId && pool.activeBinId <= highest) {
          if (hasFees) {
            return { kind: "reconcile_only", reason: "singleBin: in range, fees-only sweep" };
          }
          return { kind: "quiet", reason: "singleBin: in range, no fees" };
        }
      }

      // Out of range (or no position but has capital): drain everything and
      // re-enter as a straddle around the current active bin.
      const removeShares = new Map<number, bigint>();
      for (const bin of pm.positionBins) {
        if (bin.liquidityShare > 0n) {
          removeShares.set(bin.binId, bin.liquidityShare);
        }
      }

      // Deployable capital = idle balance + fees (when collecting) + the
      // dryRun-estimated value of the position being removed (injected by the
      // execution layer's re-planning pass; see PMState.positionValue).
      const grossA =
        pm.balance.a + (hasFees ? pm.feeBag.a : 0n) + (pm.positionValue?.a ?? 0n);
      const grossB =
        pm.balance.b + (hasFees ? pm.feeBag.b : 0n) + (pm.positionValue?.b ?? 0n);

      // Physical side rule: coinA above active, coinB below.
      const binBelow = pool.activeBinId - 1;
      const binAbove = pool.activeBinId + 1;

      const addBins: number[] = [];
      const addAmountsA: bigint[] = [];
      const addAmountsB: bigint[] = [];
      if (grossB > 0n) {
        addBins.push(binBelow);
        addAmountsA.push(0n);
        addAmountsB.push(grossB);
      }
      if (grossA > 0n) {
        addBins.push(binAbove);
        addAmountsA.push(grossA);
        addAmountsB.push(0n);
      }

      return {
        kind: "plan_and_reconcile",
        plan: {
          pmId: pm.pmId,
          removeShares,
          addAmountA: grossA,
          addAmountB: grossB,
          addBins,
          addAmountsA,
          addAmountsB,
          collectFees: hasFees,
          reason: `singleBin: recenter straddle around active bin ${pool.activeBinId}`,
          plannedActiveBinId: pool.activeBinId,
        },
      };
    },
  };
}
