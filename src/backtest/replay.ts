/**
 * Backtest replay loop. Each price observation becomes one simulated tick:
 *   1. Convert price → active bin via `binIdFromPrice`.
 *   2. Build synthetic PoolState + PMState (PM state carries over from
 *      previous tick, reflecting the strategy's last plan).
 *   3. Call `strategy.plan()` with a window of prior observations as history.
 *   4. Apply the plan to the simulated PM (remove bins, add bins, update
 *      balances naively — sum of addAmounts is removed from balance).
 *
 * v0 simplifications:
 *   - No fee accrual / no IL math (Phase 2.5).
 *   - balance after add = max(0, balance_before − sum(addAmounts)). This
 *     ignores the redistribution that happens when removeShares > 0; we
 *     credit removed liquidity back to balance at "spot" — i.e. all coinA
 *     for bins below active, all coinB for bins at/above. Coarse but enough
 *     to surface trigger frequency.
 *   - No lending; lending decisions are routed through the rebalancer's
 *     post-hoc path which the harness skips.
 */

import { binIdFromPrice, priceFromBinId } from "../domain/binMath.ts";
import { emptyLendingState } from "../sui/lending/types.ts";
import { buildStrategy } from "../strategies/registry.ts";
import { isStrategyName } from "../strategies/registry.ts";
import type { PMState, PoolState, PriceObservation, RebalancePlan } from "../domain/types.ts";
import type { PoolProfile } from "../pools/types.ts";
import type {
  BacktestInput,
  BacktestResult,
  BacktestSummary,
  TickRecord,
} from "./types.ts";
import type { StrategyOutput } from "../strategies/types.ts";

const PM_ID_SYNTHETIC = "0xbacktest";
const OWNER_SYNTHETIC = "0xowner-backtest";

function initialPm(input: BacktestInput): PMState {
  return {
    pmId: PM_ID_SYNTHETIC,
    owner: OWNER_SYNTHETIC,
    poolId: input.profile.poolId || "0xpool-backtest",
    coinTypeA: input.profile.coinTypeA,
    coinTypeB: input.profile.coinTypeB,
    balance: { a: input.initialBalanceA, b: input.initialBalanceB },
    feeBag: { a: 0n, b: 0n },
    positionBins: [],
    lending: emptyLendingState(),
  };
}

function buildPool(profile: PoolProfile, observation: PriceObservation): PoolState {
  const activeBinId = binIdFromPrice(
    observation.price,
    profile.binStep,
    true,
    profile.decimalsA,
    profile.decimalsB,
  );
  return {
    poolId: profile.poolId || "0xpool-backtest",
    activeBinId,
    binStep: profile.binStep,
    feeRateBps: profile.defaultStrategyParams.expectedFeeBps,
  };
}

/**
 * Slice the observations array between `cutoffMs` and `currentMs`, exclusive
 * of the current tick — i.e. what the strategy could "see" leading up to now.
 */
function historyFor(
  observations: PriceObservation[],
  upToIndex: number,
  windowMs: number,
): PriceObservation[] {
  if (upToIndex === 0) return [];
  const currentMs = observations[upToIndex]!.timestampMs;
  const cutoff = currentMs - windowMs;
  const out: PriceObservation[] = [];
  for (let i = upToIndex - 1; i >= 0; i--) {
    const obs = observations[i]!;
    if (obs.timestampMs < cutoff) break;
    out.push(obs);
  }
  out.reverse();
  return out;
}

/**
 * Apply a plan to the simulated PM, naively.
 *
 * Naive credit model: remove → returns liquidity to balance as either all A
 * (bin below active) or all B (bin at/above active), using the bin's "fill
 * size" estimated from the strategy's removeShares vs the prior position bin
 * amounts. Since we don't track per-bin amount during a tick, we just credit
 * the removed shares as a notional amount split by their bin id vs active.
 */
function applyPlan(pm: PMState, pool: PoolState, plan: RebalancePlan): PMState {
  // 1. remove: credit removed bin liquidity back to balance (very rough).
  let balA = pm.balance.a;
  let balB = pm.balance.b;
  const removedBinIds = new Set<number>();
  for (const [binId, share] of plan.removeShares) {
    removedBinIds.add(binId);
    // Find the prior position bin to recover its (amountA, amountB).
    const prior = pm.positionBins.find((b) => b.binId === binId);
    if (prior) {
      // Credit prior amounts back proportional to share / prior.liquidityShare.
      // v0 backtest: assume full removal (share == prior.liquidityShare).
      balA += prior.amountA;
      balB += prior.amountB;
    } else if (share > 0n) {
      // Strategy asked to remove a bin we don't track — ignore in v0.
    }
  }

  // 2. transfer fees → balance (we don't simulate fee bag growth yet, but
  // honour the request when present).
  if (plan.collectFees) {
    balA += pm.feeBag.a;
    balB += pm.feeBag.b;
  }

  // 3. add: spend balance into the planned bins. Cap by available balance.
  let totalAddA = plan.addAmountA;
  let totalAddB = plan.addAmountB;
  if (totalAddA > balA) totalAddA = balA;
  if (totalAddB > balB) totalAddB = balB;
  balA -= totalAddA;
  balB -= totalAddB;

  // 4. Rebuild positionBins from addBins / addAmountsA / addAmountsB.
  const newPositionBins: typeof pm.positionBins = [];
  for (let i = 0; i < plan.addBins.length; i++) {
    const binId = plan.addBins[i]!;
    const amountA = plan.addAmountsA[i] ?? 0n;
    const amountB = plan.addAmountsB[i] ?? 0n;
    if (amountA === 0n && amountB === 0n) continue;
    // Synthetic liquidityShare = amountA + amountB (v0 placeholder).
    const liquidityShare = amountA + amountB;
    newPositionBins.push({ binId, amountA, amountB, liquidityShare });
  }

  return {
    ...pm,
    balance: { a: balA, b: balB },
    feeBag: plan.collectFees ? { a: 0n, b: 0n } : pm.feeBag,
    positionBins: newPositionBins,
  };
}

export function runBacktest(input: BacktestInput): BacktestResult {
  if (!isStrategyName(input.strategyName)) {
    throw new Error(`unknown strategy: ${input.strategyName}`);
  }
  const strategy = buildStrategy(input.strategyName);

  let pm = initialPm(input);
  const ticks: TickRecord[] = [];
  const touchedBins = new Set<number>();
  const byKind: Record<StrategyOutput["kind"], number> = {
    plan_and_reconcile: 0,
    plan_only: 0,
    reconcile_only: 0,
    quiet: 0,
  };

  for (let i = 0; i < input.observations.length; i++) {
    const obs = input.observations[i]!;
    const pool = buildPool(input.profile, obs);
    const history = historyFor(input.observations, i, input.historyWindowMs);

    const output = strategy.plan({
      pm,
      pool,
      spot: obs,
      history,
      profile: input.profile,
    });

    byKind[output.kind] += 1;

    if (output.kind === "plan_and_reconcile" || output.kind === "plan_only") {
      pm = applyPlan(pm, pool, output.plan);
      for (const binId of output.plan.addBins) touchedBins.add(binId);
    }

    ticks.push({
      index: i,
      timestampMs: obs.timestampMs,
      spotPrice: obs.price,
      activeBinId: pool.activeBinId,
      pmBalance: { a: pm.balance.a.toString(), b: pm.balance.b.toString() },
      pmPositionBins: pm.positionBins.map((b) => b.binId),
      output,
    });
  }

  const first = input.observations[0]?.timestampMs ?? 0;
  const last = input.observations[input.observations.length - 1]?.timestampMs ?? 0;
  const summary: BacktestSummary = {
    totalTicks: ticks.length,
    byKind,
    uniqueBinsTouched: touchedBins.size,
    firstTimestampMs: first,
    lastTimestampMs: last,
    windowDays: ticks.length > 0 ? (last - first) / (24 * 60 * 60 * 1000) : 0,
    strategyName: input.strategyName,
    poolName: input.profile.name,
  };

  return { ticks, summary };
}

/**
 * Sanity-check helper used by tests: synthesize a single tick at `priceMid`
 * and call the strategy once. Returns the strategy output without mutating
 * any persistent state.
 */
export function singleTick(args: {
  profile: PoolProfile;
  strategyName: string;
  pm: PMState;
  observation: PriceObservation;
  history: PriceObservation[];
}): { output: StrategyOutput; pool: PoolState } {
  if (!isStrategyName(args.strategyName)) {
    throw new Error(`singleTick: unknown strategy '${args.strategyName}'`);
  }
  const strategy = buildStrategy(args.strategyName);
  const pool = buildPool(args.profile, args.observation);
  const output = strategy.plan({
    pm: args.pm,
    pool,
    spot: args.observation,
    history: args.history,
    profile: args.profile,
  });
  return { output, pool };
}

// silence unused-import warning when consumers only need helpers
export { priceFromBinId as _priceFromBinId };
