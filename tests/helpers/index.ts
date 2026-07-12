/**
 * Strategy test kit — the batteries for testing a strategy you wrote.
 *
 *   import {
 *     makeTestProfile, makePm, makePool, makeInput, assertPlanInvariants,
 *   } from "../helpers/index.ts";
 *
 *   const out = await createMyStrategy().plan(makeInput({ activeBin: 1445 }));
 *   assertPlanInvariants(out, makeTestProfile(), 1445);
 *
 * Why this exists: every file under `tests/strategies/` used to hand-roll ~100
 * lines of near-identical `makeProfile` / `makePm` / `makePool` fixtures, and
 * the README told fork authors to copy-paste them a fourth time. Worse, the
 * bin-orientation assertions — the single most valuable check for a new
 * strategy — were a private function duplicated across two files. The repo
 * shipped an inverted side-split once precisely because nothing asserted plan
 * shape.
 *
 * `assertPlanInvariants` delegates to `src/decision/planInvariants.ts`, the
 * SAME validator the rebalancer runs before submitting on-chain. So a plan that
 * passes here is a plan the live agent will accept — the test and the runtime
 * cannot drift apart.
 */

import { expect } from "bun:test";
import { validatePlan, formatViolations } from "../../src/decision/planInvariants.ts";
import { emptyLendingState } from "../../src/sui/lending/types.ts";
import type {
  PMState,
  PoolState,
  PriceObservation,
  RebalancePlan,
} from "../../src/domain/types.ts";
import type { PoolProfile } from "../../src/pools/types.ts";
import type { StrategyInput, StrategyOutput } from "../../src/strategies/types.ts";
import type { MarketSnapshot } from "../../src/prediction/types.ts";

const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";

export const BASE_ACTIVE_BIN = 1445;

/**
 * A SUI/USDC-shaped profile: PHYSICAL pool order is `Pool<USDC=6, SUI=9>` and
 * `poolCoinAIsQuote = true`, so bin id ↑ means the human SUI price ↓.
 *
 * Test against this inverted shape by default ON PURPOSE — a strategy that only
 * works on a non-inverted pool has an orientation bug that a "nice" profile
 * would hide.
 */
export function makeTestProfile(overrides: Partial<PoolProfile> = {}): PoolProfile {
  return {
    name: "sui-usdc",
    poolId: "0xpool",
    coinTypeA: SUI, // LOGICAL (base) — used for lending/labelling
    coinTypeB: USDC,
    decimalsA: 9,
    decimalsB: 6,
    poolCoinADecimals: 6, // PHYSICAL A = USDC
    poolCoinBDecimals: 9, // PHYSICAL B = SUI
    poolCoinAIsQuote: true,
    binStep: 50,
    pricePairLabel: "SUI/USDC",
    defaultStrategyParams: { binWidth: 10, expectedFeeBps: 25 },
    lendingPolicy: {},
    network: "mainnet",
    ...overrides,
  };
}

export interface MakePmOptions {
  /** PHYSICAL coinA (USDC for SUI/USDC). */
  balanceA?: bigint;
  /** PHYSICAL coinB (SUI for SUI/USDC). */
  balanceB?: bigint;
  feeBagA?: bigint;
  feeBagB?: bigint;
  positionBins?: PMState["positionBins"];
  /**
   * Value the strategy is about to free by removing its position. The live
   * rebalancer injects this from a dryRun of the remove prefix, and strategies
   * are contracted to size adds from `balance + feeBag + positionValue`. Set it
   * whenever you test a RECENTER, or your strategy will correctly see zero
   * deployable capital and go quiet.
   */
  positionValue?: { a: bigint; b: bigint };
}

export function makePm(opts: MakePmOptions = {}): PMState {
  return {
    pmId: "0xpm",
    owner: "0xowner",
    poolId: "0xpool",
    coinTypeA: USDC, // PHYSICAL A
    coinTypeB: SUI, // PHYSICAL B
    balance: { a: opts.balanceA ?? 5_000_000n, b: opts.balanceB ?? 3_000_000_000n },
    feeBag: { a: opts.feeBagA ?? 0n, b: opts.feeBagB ?? 0n },
    positionBins: opts.positionBins ?? [],
    lending: emptyLendingState(),
    ...(opts.positionValue !== undefined ? { positionValue: opts.positionValue } : {}),
  };
}

export function makePool(activeBinId: number = BASE_ACTIVE_BIN): PoolState {
  return { poolId: "0xpool", activeBinId, binStep: 50, feeRateBps: 25 };
}

export interface MakeInputOptions extends MakePmOptions {
  activeBin?: number;
  profile?: PoolProfile;
  /** Oldest-first price history. Defaults to a flat 1.00 series. */
  history?: PriceObservation[];
  spotPrice?: string;
  /**
   * Derivatives / cross-asset context. Omit to simulate a data outage — the
   * live rebalancer passes `undefined` when the aggregator has no data, and a
   * strategy must survive that.
   */
  snapshot?: MarketSnapshot;
}

export function makeInput(opts: MakeInputOptions = {}): StrategyInput {
  const activeBin = opts.activeBin ?? BASE_ACTIVE_BIN;
  const price = opts.spotPrice ?? "1.00";
  const now = 1_700_000_000_000;
  const history =
    opts.history ??
    Array.from({ length: 30 }, (_, i) => ({
      price,
      timestampMs: now - (29 - i) * 60_000,
      source: "test",
    }));

  return {
    pm: makePm(opts),
    pool: makePool(activeBin),
    spot: { price, timestampMs: now, source: "test" },
    history,
    profile: opts.profile ?? makeTestProfile(),
    ...(opts.snapshot !== undefined ? { snapshot: opts.snapshot } : {}),
  };
}

/** Pull the plan out of a StrategyOutput, failing the test if there isn't one. */
export function expectPlan(output: StrategyOutput): RebalancePlan {
  if (output.kind !== "plan_and_reconcile" && output.kind !== "plan_only") {
    throw new Error(
      `expected a plan, got kind='${output.kind}'` +
        ("reason" in output ? ` (reason: ${output.reason})` : ""),
    );
  }
  return output.plan;
}

/**
 * Assert the plan is physically executable on a DLMM.
 *
 * Runs the SAME validator the rebalancer runs before submitting, so anything
 * that passes here will not be rejected by the live guard:
 *   - bins ABOVE the active bin carry physical coinA only; BELOW, coinB only
 *   - nothing is placed ON the active bin (composition fee)
 *   - Σ per-bin amounts === the declared addAmountA / addAmountB
 *   - parallel arrays, non-negative amounts
 *
 * Accepts a StrategyOutput or a bare RebalancePlan. A `quiet` / `reconcile_only`
 * output is vacuously valid (there is no plan to check).
 */
export function assertPlanInvariants(
  planOrOutput: RebalancePlan | StrategyOutput,
  profile: PoolProfile,
  activeBinId: number,
): void {
  const plan =
    "kind" in planOrOutput
      ? planOrOutput.kind === "plan_and_reconcile" || planOrOutput.kind === "plan_only"
        ? planOrOutput.plan
        : null
      : planOrOutput;

  if (plan === null) return; // quiet / reconcile_only: nothing placed

  const violations = validatePlan(plan, profile, activeBinId);
  if (violations.length > 0) {
    throw new Error(
      `plan violates DLMM physical invariants (active bin ${activeBinId}):\n` +
        formatViolations(violations) +
        `\n\nplan: bins=${JSON.stringify(plan.addBins)}` +
        ` A=${JSON.stringify(plan.addAmountsA.map(String))}` +
        ` B=${JSON.stringify(plan.addAmountsB.map(String))}`,
    );
  }
  expect(violations).toHaveLength(0);
}
