/**
 * A worked example of a fork-authored strategy. Registered in
 * `agent.config.example.ts`; run it with `STRATEGY=example`.
 *
 * It holds a fixed-width symmetric band around the active bin and recenters on
 * drift. That is deliberately the dumbest possible policy — it shows the
 * CONTRACT, not the alpha. Replace step 1.
 *
 * Two rules the framework will NOT fix for you:
 *
 *  1. PHYSICAL SIDE RULE. Bins ABOVE the active bin hold physical coinA only;
 *     bins BELOW hold coinB only; never place ON the active bin (the chain
 *     allows it but charges a composition fee). `pm.balance.a/b` are PHYSICAL
 *     amounts — for SUI/USDC, physical A is USDC.
 *
 *  2. "Bin up" is NOT "price up". SUI/USDC is inverted (poolCoinAIsQuote=true),
 *     so a higher bin id means a LOWER SUI price. Route any direction-sensitive
 *     decision through src/domain/binMath.ts. This example is direction-agnostic
 *     (a symmetric band), so it needs no orientation logic at all — the safest
 *     place for a new strategy to start.
 *
 * Sizing: size from the PRE-remove snapshot (balance + fee bag + the injected
 * `positionValue` of what you are about to remove). The rebalancer re-scales
 * your per-bin amounts to the actual post-remove balances, so you are expressing
 * RATIOS, not realized amounts.
 */

import type { Strategy, StrategyInput, StrategyOutput } from "../src/strategies/types.ts";

export function createExampleStrategy(
  params: { halfWidth?: number; driftTolerance?: number } = {},
): Strategy {
  const halfWidth = params.halfWidth ?? 5;
  const driftTolerance = params.driftTolerance ?? 2;

  return {
    name: "example",
    historyWindowMs: 30 * 60 * 1000, // omit for the 5-minute default

    async plan({ pm, pool }: StrategyInput): Promise<StrategyOutput> {
      const hasFees = pm.feeBag.a > 0n || pm.feeBag.b > 0n;
      const hasBalance = pm.balance.a > 0n || pm.balance.b > 0n;

      if (pm.positionBins.length === 0 && !hasBalance && !hasFees) {
        return { kind: "quiet", reason: "example: nothing to work with" };
      }

      // Trigger: still centered enough?
      if (pm.positionBins.length > 0) {
        const bins = pm.positionBins.map((b) => b.binId);
        const center = Math.round((Math.min(...bins) + Math.max(...bins)) / 2);
        const drift = Math.abs(pool.activeBinId - center);
        if (drift <= driftTolerance) {
          return hasFees
            ? { kind: "reconcile_only", reason: `example: centered (drift ${drift}), fee sweep` }
            : { kind: "quiet", reason: `example: centered (drift ${drift})` };
        }
      }

      // 1. YOUR ALPHA GOES HERE. Turn `history` (or a PredictionProvider, an
      //    external signal, an LLM call — plan() is async) into a target band.
      //    This example just uses a fixed width around the active bin.
      const width = halfWidth;

      // 2. Drain the old position.
      const removeShares = new Map<number, bigint>();
      for (const bin of pm.positionBins) {
        if (bin.liquidityShare > 0n) removeShares.set(bin.binId, bin.liquidityShare);
      }

      // 3. Size from the pre-remove snapshot.
      const grossA = pm.balance.a + (hasFees ? pm.feeBag.a : 0n) + (pm.positionValue?.a ?? 0n);
      const grossB = pm.balance.b + (hasFees ? pm.feeBag.b : 0n) + (pm.positionValue?.b ?? 0n);

      // 4. Split by the physical side rule: coinA above active, coinB below,
      //    active skipped.
      const addBins: number[] = [];
      const addAmountsA: bigint[] = [];
      const addAmountsB: bigint[] = [];
      const perBinA = grossA / BigInt(width);
      const perBinB = grossB / BigInt(width);

      for (let i = 1; i <= width; i++) {
        if (perBinB > 0n) {
          addBins.push(pool.activeBinId - i);
          addAmountsA.push(0n);
          addAmountsB.push(perBinB);
        }
        if (perBinA > 0n) {
          addBins.push(pool.activeBinId + i);
          addAmountsA.push(perBinA);
          addAmountsB.push(0n);
        }
      }

      if (addBins.length === 0) {
        return { kind: "quiet", reason: "example: capital below one unit per bin" };
      }

      return {
        kind: "plan_and_reconcile",
        plan: {
          pmId: pm.pmId,
          removeShares,
          // Σ per-bin amounts must equal addAmountA/B — integer division above
          // leaves a remainder, so report what we placed, not gross.
          addAmountA: perBinA * BigInt(width),
          addAmountB: perBinB * BigInt(width),
          addBins,
          addAmountsA,
          addAmountsB,
          collectFees: hasFees,
          reason: `example: recenter ±${width} bins on active ${pool.activeBinId}`,
          plannedActiveBinId: pool.activeBinId,
        },
      };
    },
  };
}
