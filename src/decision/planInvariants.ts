/**
 * Physical validity of a RebalancePlan.
 *
 * These are not style rules — they are the rules the DLMM itself imposes, and
 * getting one wrong silently places a user's liquidity on the wrong side of the
 * market. This repo shipped exactly that bug once (an inverted side-split went
 * unnoticed because nothing asserted plan shape), which is why the check now
 * lives in one place and runs BOTH in tests and at runtime, before submission.
 *
 * The invariants (verified on mainnet — see CLAUDE.md "Load-bearing execution
 * facts", and `scripts/probe-bin-orientation.ts`):
 *
 *   1. PHYSICAL SIDE RULE. Bins ABOVE the active bin hold physical coinA only;
 *      bins BELOW hold physical coinB only. Note this is about BIN INDEX, not
 *      price: on an inverted pool (poolCoinAIsQuote) a higher bin id is a LOWER
 *      human price. That is precisely why people get it backwards.
 *   2. NEVER place on the active bin. The chain allows it, but charges a
 *      composition fee whenever the add ratio differs from the bin's internal
 *      ratio. Project policy: don't.
 *   3. Σ per-bin amounts must equal the declared totals — the executor funds the
 *      PTB from addAmountA/addAmountB, so a mismatch either under-funds the add
 *      (it aborts) or strands capital.
 *   4. The three add arrays must be the same length, and amounts non-negative.
 *
 * Pure — no I/O, no chain, no config. Returns violations rather than throwing,
 * so the caller decides whether that means "fail this test" or "refuse to
 * submit this tick".
 */

import type { RebalancePlan } from "../domain/types.ts";
import type { PoolProfile } from "../pools/types.ts";

export interface PlanViolation {
  /** Stable machine-readable code — safe to switch on. */
  code:
    | "active_bin_placement"
    | "side_rule_violation"
    | "amount_sum_mismatch"
    | "array_length_mismatch"
    | "negative_amount";
  message: string;
}

/**
 * Check a plan against the DLMM's physical rules.
 *
 * @param activeBinId The pool's active bin AT PLAN TIME (`plan.plannedActiveBinId`
 *   when the strategy declared it; otherwise the caller's observed active bin).
 * @returns Every violation found. Empty array = the plan is physically valid.
 *   (Valid does NOT mean profitable — this says nothing about the strategy's
 *   judgement, only that the plan can be executed as written.)
 */
export function validatePlan(
  plan: RebalancePlan,
  _profile: PoolProfile,
  activeBinId: number,
): PlanViolation[] {
  const violations: PlanViolation[] = [];
  const { addBins, addAmountsA, addAmountsB } = plan;

  // 4. Structural: parallel arrays.
  if (addBins.length !== addAmountsA.length || addBins.length !== addAmountsB.length) {
    violations.push({
      code: "array_length_mismatch",
      message:
        `addBins (${addBins.length}), addAmountsA (${addAmountsA.length}) and ` +
        `addAmountsB (${addAmountsB.length}) must be the same length`,
    });
    // Everything below indexes all three in lockstep; bail out rather than
    // report a cascade of bogus violations.
    return violations;
  }

  let sumA = 0n;
  let sumB = 0n;

  for (let i = 0; i < addBins.length; i++) {
    const binId = addBins[i]!;
    const amountA = addAmountsA[i]!;
    const amountB = addAmountsB[i]!;

    if (amountA < 0n || amountB < 0n) {
      violations.push({
        code: "negative_amount",
        message: `bin ${binId}: negative amount (A=${amountA}, B=${amountB})`,
      });
    }

    sumA += amountA;
    sumB += amountB;

    // 2. Active-bin placement.
    if (binId === activeBinId) {
      violations.push({
        code: "active_bin_placement",
        message:
          `bin ${binId} IS the active bin — never place there (composition fee). ` +
          `Place on ${activeBinId - 1} / ${activeBinId + 1} instead.`,
      });
      continue; // the side rule is undefined on the active bin
    }

    // 1. Physical side rule.
    if (binId > activeBinId && amountB > 0n) {
      violations.push({
        code: "side_rule_violation",
        message:
          `bin ${binId} is ABOVE the active bin (${activeBinId}) so it can hold ` +
          `physical coinA only, but the plan puts ${amountB} of coinB there. ` +
          `Remember: bin index, not price — on an inverted pool a higher bin id ` +
          `is a LOWER human price.`,
      });
    }
    if (binId < activeBinId && amountA > 0n) {
      violations.push({
        code: "side_rule_violation",
        message:
          `bin ${binId} is BELOW the active bin (${activeBinId}) so it can hold ` +
          `physical coinB only, but the plan puts ${amountA} of coinA there. ` +
          `Remember: bin index, not price — on an inverted pool a lower bin id ` +
          `is a HIGHER human price.`,
      });
    }
  }

  // 3. Totals must match what the executor will fund.
  if (sumA !== plan.addAmountA) {
    violations.push({
      code: "amount_sum_mismatch",
      message: `Σ addAmountsA (${sumA}) !== addAmountA (${plan.addAmountA})`,
    });
  }
  if (sumB !== plan.addAmountB) {
    violations.push({
      code: "amount_sum_mismatch",
      message: `Σ addAmountsB (${sumB}) !== addAmountB (${plan.addAmountB})`,
    });
  }

  return violations;
}

/** Human-readable one-liner for logs and test failures. */
export function formatViolations(violations: PlanViolation[]): string {
  return violations.map((v, i) => `  ${i + 1}. [${v.code}] ${v.message}`).join("\n");
}
