/**
 * Pure plan-amount math used by the execution layer.
 *
 * Strategies size their per-bin amounts from the PRE-remove PM snapshot
 * (balance + fee bag). The value freed by `removeShares` in the same plan is
 * not visible to them (per-bin position amounts are 0n in v0 reads), so the
 * executor layer re-scales the plan once the realized post-remove balances
 * are known:
 *   - legacy path: exact — the PM is re-fetched between remove and add;
 *   - unified path: estimated — a dryRun of the collect+remove prefix yields
 *     the AgentLiquidityRemoved amounts, minus a safety haircut.
 *
 * On-chain semantics this guards (verified against cdpm.move):
 *   `withdraw_from_balance` clamps to available (no abort), but the per-bin
 *   amounts vectors are exact and binding — if their sum exceeds what was
 *   actually withdrawn, `coin.split` aborts the whole PTB. Undershoot is safe
 *   (the residual stays in balance and is swept to lending next).
 */

import type { RebalancePlan } from "../domain/types.ts";

/**
 * Minimum absolute amount per bin (raw units) worth keeping after a rescale —
 * mirrors diffPlanner's dust threshold. Bins where BOTH sides fall below this
 * are dropped.
 */
export const MIN_BIN_AMOUNT_RESCALE = 100n;

/**
 * Proportionally re-scale a plan's per-bin amounts so that each side's total
 * equals the given available balance, preserving the per-bin weight shape.
 *
 * - Scales both up and down (`available` may exceed the planned total when
 *   just-removed capital lands in the balance).
 * - Rounding dust is assigned to the largest bin of the side so the sum is
 *   exactly `available` (when scaling to a non-zero total).
 * - A side whose planned total is 0n stays all-zero (no shape to scale).
 * - Bins where both sides end below `minBinAmount` are dropped.
 * - `removeShares` / `collectFees` are untouched; `reason` gets " [rescaled]".
 *
 * Returns the same plan object when nothing changes (both sides already equal
 * their available totals).
 */
export function rescalePlanToAvailable(
  plan: RebalancePlan,
  availableA: bigint,
  availableB: bigint,
  minBinAmount: bigint = MIN_BIN_AMOUNT_RESCALE,
): RebalancePlan {
  if (availableA < 0n || availableB < 0n) {
    throw new RangeError(
      `rescalePlanToAvailable: negative available (a=${availableA}, b=${availableB})`,
    );
  }
  const totalA = plan.addAmountsA.reduce((s, v) => s + v, 0n);
  const totalB = plan.addAmountsB.reduce((s, v) => s + v, 0n);

  if (totalA === availableA && totalB === availableB) return plan;

  const scaledA = scaleSide(plan.addAmountsA, totalA, availableA);
  const scaledB = scaleSide(plan.addAmountsB, totalB, availableB);

  // Drop bins that became dust on both sides.
  const bins: number[] = [];
  const outA: bigint[] = [];
  const outB: bigint[] = [];
  for (let i = 0; i < plan.addBins.length; i++) {
    const a = scaledA[i] ?? 0n;
    const b = scaledB[i] ?? 0n;
    if (a < minBinAmount && b < minBinAmount) continue;
    bins.push(plan.addBins[i]!);
    outA.push(a);
    outB.push(b);
  }

  return {
    ...plan,
    addBins: bins,
    addAmountsA: outA,
    addAmountsB: outB,
    addAmountA: outA.reduce((s, v) => s + v, 0n),
    addAmountB: outB.reduce((s, v) => s + v, 0n),
    reason: `${plan.reason} [rescaled]`,
  };
}

/**
 * Scale one side's per-bin amounts so they sum to `target`, preserving
 * proportions; dust to the largest bin. `oldTotal === 0n` → all zeros
 * (no shape to distribute over).
 */
function scaleSide(amounts: bigint[], oldTotal: bigint, target: bigint): bigint[] {
  if (oldTotal === 0n || amounts.length === 0) return amounts.map(() => 0n);
  if (oldTotal === target) return [...amounts];

  const scaled = amounts.map((v) => (v * target) / oldTotal);
  let allocated = scaled.reduce((s, v) => s + v, 0n);

  if (allocated < target) {
    // Assign rounding dust to the largest original bin.
    let maxIdx = 0;
    for (let i = 1; i < amounts.length; i++) {
      if (amounts[i]! > amounts[maxIdx]!) maxIdx = i;
    }
    scaled[maxIdx] = scaled[maxIdx]! + (target - allocated);
  }
  return scaled;
}
