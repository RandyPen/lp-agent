/**
 * PnL backtest — what a strategy would have EARNED, not just what it would have DONE.
 *
 * The decision-trace backtest (./replay.ts) replays price ticks and reports
 * trigger frequency and bins touched. It cannot rank two strategies, because it
 * models no fees, no impermanent loss, and no inventory. That is a strange gap
 * for a quant framework: "is my strategy any good?" had no answer short of
 * running it live.
 *
 * This closes it by reusing the machinery the live shadow fleet already runs:
 *
 *   ShadowBook  — a hypothetical position, filled bin-by-bin from REAL on-chain
 *                 Cetus SwapEvents, accruing REAL taker fees at the real fee rate.
 *   parseSwapEvent — the same parser the live fleet uses.
 *
 * So a PnL backtest is simply the shadow fleet driven by persisted history
 * instead of live RPC. There is no second fill model to keep in sync — which is
 * the whole point, since a divergent backtest model is worse than none.
 *
 * WHAT THIS IS NOT
 * ----------------
 * It is still a SIMULATION, and it makes one load-bearing assumption:
 * **your liquidity did not change the flow it is being credited for.** The swap
 * events are what happened WITHOUT your position in the book. In reality, adding
 * liquidity to a bin takes fill share from the LPs who were there, and can move
 * where the active bin ends up. So this over-credits a strategy that would have
 * been a large share of a thin bin.
 *
 * Treat it as a way to cheaply KILL bad ideas, never to bless good ones. Shadow
 * mode (live market, real fills, zero capital) remains the honest evaluator.
 */

import { ShadowBook, parseSwapEvent, type RawDlmmSwapEvent } from "../services/shadowBook.ts";
import { buildStrategy } from "../strategies/registry.ts";
import { saveFillBoundary, clearFillBoundary } from "../strategies/positionState.ts";
import { validatePlan, formatViolations } from "../decision/planInvariants.ts";
import { binIdForHumanPrice, orientationOf, humanPriceForBin } from "../domain/binMath.ts";
import { log } from "../lib/logger.ts";
import type { PoolProfile } from "../pools/types.ts";
import type { PriceObservation } from "../domain/types.ts";
import type { StrategyInput, StrategyOutput } from "../strategies/types.ts";

/** Identity used for the simulated PM's cross-tick state (position_state). */
const PM_ID = "backtest:pnl";

/** One raw swap event as persisted by the backfill. */
export interface StoredSwapEvent {
  tsMs: number;
  raw: RawDlmmSwapEvent;
}

export interface PnlBacktestInput {
  profile: PoolProfile;
  strategyName: string;
  /** Oldest-first. The fill source. */
  swaps: StoredSwapEvent[];
  /** Initial PHYSICAL balances (coinA, coinB) — raw atomic units. */
  initialA: bigint;
  initialB: bigint;
  /** How often the strategy is allowed to re-plan. Default 60s. */
  tickIntervalMs?: number;
  /** Price history window handed to the strategy. Default: strategy's own. */
  historyWindowMs?: number;
  /** Physical coin type tags, for the PMState projection. */
  physicalTypeA: string;
  physicalTypeB: string;
}

export interface PnlSample {
  tsMs: number;
  price: number;
  navQuote: number;
  hodlQuote: number;
  feeIncomeQuote: number;
  fills: number;
}

export interface PnlSummary {
  strategyName: string;
  poolName: string;
  firstTsMs: number;
  lastTsMs: number;
  windowDays: number;

  swapsReplayed: number;
  /** Swaps that hit a bin the book actually held liquidity in. */
  fills: number;
  /**
   * Fills that landed in a bin we held but did NOT fully cross. ShadowBook
   * credits nothing for these (it can't infer our share of a partially-consumed
   * bin), so fee income is UNDER-stated by however many of these there are.
   * A high count relative to `fills` means treat the fee numbers with suspicion.
   */
  skippedTerminalFills: number;
  rebalances: number;

  initialNavQuote: number;
  finalNavQuote: number;
  /** Value of simply holding the initial inventory, marked at the final price. */
  finalHodlQuote: number;

  /** Taker fees earned, in quote units. This is the LP's revenue. */
  feeIncomeQuote: number;

  /** finalNav / initialNav − 1. */
  totalReturnPct: number;
  /** The number that actually matters: did market-making beat just holding? */
  vsHodlPct: number;
  /**
   * Impermanent loss: the position's value EX-FEES versus holding.
   * Negative = the inventory rebalancing cost you money (the normal case).
   * `vsHodl ≈ fees + IL` — fees are what you're paid to bear this.
   */
  ilQuote: number;

  /** Fee income annualised over the window, as a % of initial NAV. */
  feeAprPct: number;
}

export interface PnlBacktestResult {
  samples: PnlSample[];
  summary: PnlSummary;
}

export async function runPnlBacktest(input: PnlBacktestInput): Promise<PnlBacktestResult> {
  const {
    profile,
    strategyName,
    swaps,
    initialA,
    initialB,
    physicalTypeA,
    physicalTypeB,
  } = input;

  if (swaps.length === 0) {
    throw new Error("runPnlBacktest: no swap events to replay");
  }

  const tickIntervalMs = input.tickIntervalMs ?? 60_000;
  const strategy = buildStrategy(strategyName);

  // Cross-tick strategy state (presenceSweep's fill boundary) is persisted to
  // position_state under this id. Clear it first so a re-run is deterministic
  // and does not inherit the previous run's boundary.
  clearFillBoundary(PM_ID);
  const orientation = orientationOf(profile);
  const book = new ShadowBook(profile, initialA, initialB);

  const samples: PnlSample[] = [];
  const history: PriceObservation[] = [];
  const historyWindowMs = input.historyWindowMs ?? strategy.historyWindowMs ?? 5 * 60 * 1000;

  let rebalances = 0;
  let nextTickMs = swaps[0]!.tsMs;
  let initialNav: number | null = null;

  const priceOf = (raw: RawDlmmSwapEvent): number => {
    // The active bin after the swap is the last bin it touched.
    const last = raw.bin_swaps[raw.bin_swaps.length - 1];
    if (!last) return NaN;
    const binId =
      last.bin_id.bits >= 0x80000000 ? last.bin_id.bits - 0x100000000 : last.bin_id.bits;
    return humanPriceForBin(orientation, binId);
  };

  for (const ev of swaps) {
    const price = priceOf(ev.raw);
    if (!Number.isFinite(price) || price <= 0) continue;

    // 1. Fill the book from the real swap FIRST — the strategy does not get to
    //    react to a swap before it happens.
    const parsed = parseSwapEvent(ev.raw, physicalTypeA, physicalTypeB, ev.tsMs);
    book.applySwap(parsed);

    history.push({ price: price.toFixed(8), timestampMs: ev.tsMs, source: "cetus_swap" });
    const cutoff = ev.tsMs - historyWindowMs;
    while (history.length > 1 && history[0]!.timestampMs < cutoff) history.shift();

    if (initialNav === null) initialNav = book.navQuote(price);

    // 2. Let the strategy re-plan on its own cadence.
    if (ev.tsMs < nextTickMs) continue;
    nextTickMs = ev.tsMs + tickIntervalMs;

    const activeBinId = binIdForHumanPrice(orientation, price);
    const strategyInput: StrategyInput = {
      pm: book.toPmState(PM_ID, profile.poolId, physicalTypeA, physicalTypeB),
      pool: {
        poolId: profile.poolId,
        activeBinId,
        binStep: profile.binStep,
        feeRateBps: profile.defaultStrategyParams.expectedFeeBps,
      },
      spot: { price: price.toFixed(8), timestampMs: ev.tsMs, source: "cetus_swap" },
      history: [...history],
      profile,
      // No `snapshot`: persisted swap history carries no derivatives or
      // cross-asset data. A strategy that hard-depends on it cannot be
      // PnL-backtested — see StrategyInput.snapshot.
    };

    const output: StrategyOutput = await strategy.plan(strategyInput);

    if (output.kind === "plan_and_reconcile" || output.kind === "plan_only") {
      // Same guard the live rebalancer applies — a backtest that happily
      // simulates a physically impossible plan would report profits the chain
      // would never have paid.
      const violations = validatePlan(output.plan, profile, activeBinId);
      if (violations.length > 0) {
        throw new Error(
          `strategy '${strategyName}' produced an invalid plan at ts=${ev.tsMs}:\n` +
            formatViolations(violations),
        );
      }
      book.applyPlan(output.plan);
      rebalances++;
    }

    // Persist the fill boundary, exactly as the live rebalancer and the shadow
    // fleet do. This is not optional bookkeeping: `presenceSweep` READS it back
    // (loadPositionState → fillBoundaryBinId) to know which side of the anchor
    // to leave idle. Without it, presenceSweep silently degenerates into
    // presenceAnchor and the backtest reports the two as identical — which is
    // exactly the kind of quietly-wrong answer a backtest must never give.
    if (
      (output.kind === "plan_and_reconcile" || output.kind === "plan_only") &&
      output.fillBoundary !== undefined
    ) {
      saveFillBoundary(PM_ID, output.fillBoundary, strategyName);
    }

    samples.push({
      tsMs: ev.tsMs,
      price,
      navQuote: book.navQuote(price),
      hodlQuote: book.hodlQuote(price),
      feeIncomeQuote: book.feeIncomeQuote(price),
      fills: book.fills,
    });
  }

  if (samples.length === 0 || initialNav === null) {
    throw new Error("runPnlBacktest: no usable swap events (all had unparseable prices)");
  }

  const last = samples[samples.length - 1]!;
  const firstTsMs = swaps[0]!.tsMs;
  const lastTsMs = swaps[swaps.length - 1]!.tsMs;
  const windowDays = (lastTsMs - firstTsMs) / 86_400_000;

  const feeIncome = last.feeIncomeQuote;
  // Position value ex-fees vs. just holding: the pure inventory effect.
  const il = last.navQuote - feeIncome - last.hodlQuote;

  const summary: PnlSummary = {
    strategyName,
    poolName: profile.name,
    firstTsMs,
    lastTsMs,
    windowDays,
    swapsReplayed: swaps.length,
    fills: book.fills,
    skippedTerminalFills: book.skippedTerminalFills,
    rebalances,
    initialNavQuote: initialNav,
    finalNavQuote: last.navQuote,
    finalHodlQuote: last.hodlQuote,
    feeIncomeQuote: feeIncome,
    totalReturnPct: (last.navQuote / initialNav - 1) * 100,
    vsHodlPct: (last.navQuote / last.hodlQuote - 1) * 100,
    ilQuote: il,
    feeAprPct:
      windowDays > 0 && initialNav > 0
        ? (feeIncome / initialNav) * (365 / windowDays) * 100
        : 0,
  };

  if (book.skippedTerminalFills > 0) {
    log.warn("pnlReplay: some fills hit bins the book did not hold", {
      skipped: book.skippedTerminalFills,
    });
  }

  return { samples, summary };
}
