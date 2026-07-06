/**
 * Diff-based rebalance planner (W6 decision engine).
 *
 * Core responsibility: given the current PM state, pool state, three-state
 * machine context, and a model prediction, compute the minimal RebalancePlan
 * that moves the liquidity distribution toward the target, or return null when
 * the current position is already close enough (below min-improvement
 * threshold).
 *
 * Design references:
 *   docs/decision-engine-design.md §3, §5
 *   docs/implementation-plan-v1.md §5.2, §10 item 6
 *
 * Constraints honoured:
 *   - PTB ≤ 6 op hard limit (countPlanOps / shrink logic)
 *   - No swaps — agent can only add/remove liquidity
 *   - Fee-aware ask-min-price (ask_min_price = avg_cost × (1 + 2×fee + 0.003))
 *   - EXTREME state → full withdrawal, no re-add
 *   - TREND strong bias → 25 % reverse position
 *   - Tolerance guard → null when position is already good enough
 *
 * Pure function — no DB access, no network, no Date.now().
 */

import type { PMState, PoolState, RebalancePlan } from "../domain/types.ts";
import type { StateContext, PredictionResponse } from "../prediction/types.ts";
import type { PoolProfile } from "../pools/types.ts";
import { normCdf } from "../forecast/binWeights.ts";
import {
  binDirection,
  humanPriceForBin,
  orientationOf,
  type PoolOrientation,
} from "../domain/binMath.ts";
import {
  applyInventoryScales,
  clampToAvailable,
  computeInventoryAdjustment,
  type InventoryAdjustment,
} from "./inventory.ts";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface DiffPlanInput {
  pm: PMState;
  pool: PoolState;
  ctx: StateContext;
  pred: PredictionResponse;
  profile: PoolProfile;
  /**
   * Age stop-loss directives (C2, decision-engine-design §4.2), derived by
   * the orchestration layer from the lot book (lotStore + ageStopLoss):
   *   - `relaxedAskFloorBin`: ask-side bins at or beyond this bin (in the
   *     rising-price direction) are exempt from the ask-min-profit filter —
   *     the relaxed floor IS the new minimum (cost × 1.005).
   *   - `forceLiquidationBins`: bins that MUST be in the candidate set
   *     (typically active ± 1 in the rising-price direction) so stale
   *     inventory gets parked for immediate liquidation; they bypass the
   *     ask-min filter, and their presence bypasses the shape-deviation
   *     quiet guard.
   */
  stopLoss?: {
    relaxedAskFloorBin: number | null;
    forceLiquidationBins: number[];
  };
}

/**
 * Compute the ops the *plan portion* of a unified PTB would consume.
 *
 * Op accounting (mirrors buildUnifiedRebalanceTx commandCount logic):
 *   +1  agent_collect_fee          when plan.collectFees || pm.feeBag.a/b > 0
 *   +1  agent_remove_liquidity     when plan.removeShares.size > 0
 *   +1  agent_transfer_fee[A]      when pm.feeBag.a > 0
 *   +1  agent_transfer_fee[B]      when pm.feeBag.b > 0
 *   +1  agent_add_liquidity        when plan.addBins.length > 0 and amounts > 0
 *
 * Lending decisions are added by the rebalancer after this layer and are NOT
 * counted here. Callers that need the full PTB count must add lending op
 * counts on top.
 *
 * Note: the active-bin constraint (no liquidity on the active bin itself) is
 * enforced during plan construction; this counter only reflects CDPM calls.
 */
export function countPlanOps(plan: RebalancePlan, pm: PMState): number {
  let ops = 0;
  const hasFeeBag = pm.feeBag.a > 0n || pm.feeBag.b > 0n;
  if (plan.collectFees || hasFeeBag) ops++;
  if (plan.removeShares.size > 0) ops++;
  if (pm.feeBag.a > 0n) ops++;
  if (pm.feeBag.b > 0n) ops++;
  if (plan.addBins.length > 0 && (plan.addAmountA > 0n || plan.addAmountB > 0n)) ops++;
  return ops;
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/** PTB hard maximum (docs §5.3 and implementation-plan §10 item 6). */
const PTB_MAX_OPS = 6;

/**
 * Ask minimum profit fraction from docs/decision-engine-design.md §4.3.
 *   ask_min_price = avg_cost × (1 + 2×fee + min_profit)
 * 0.003 = 0.3 % minimum profit above break-even.
 */
const ASK_MIN_PROFIT_FRAC = 0.003;

/**
 * Min-improvement threshold: the shape deviation (sum of |target_w - current_w|
 * across all bins) below which we consider the current position "close enough"
 * and return null. Calibration note: a value of 0.15 means that the L1
 * distance between the target weight vector and the implied current weight
 * vector must exceed 15 % of total mass before we act. This prevents
 * churning on micro-adjustments that would consume gas without meaningfully
 * improving fill exposure.
 *
 * See decision-engine-design.md §5.1 (min threshold for "below min threshold").
 */
const MIN_SHAPE_DEVIATION = 0.15;

/**
 * Minimum absolute amount per bin (in raw units) to bother adding — avoids
 * dust transactions and zero-share Move calls.
 */
const MIN_BIN_AMOUNT = 100n;

// ---------------------------------------------------------------------------
// Weight computation helpers
// ---------------------------------------------------------------------------

/**
 * Gaussian (normal) weight for bin `k` relative to `centerBin` using
 * `widthSigma` as σ (in bin units). Returns the raw unnormalized value;
 * callers normalize across the range.
 *
 * This mirrors the formula in decision-engine-design.md §3.1:
 *   w[k] = exp(-(k - center)² / (2 × σ²))
 */
function gaussianWeight(k: number, centerBin: number, widthSigma: number): number {
  if (widthSigma <= 0) return k === centerBin ? 1 : 0;
  const d = k - centerBin;
  return Math.exp(-(d * d) / (2 * widthSigma * widthSigma));
}

/**
 * Compute per-bin weight vector for NORMAL state.
 *
 * Bins are clipped to PM boundaries (lowerBin..upperBin). The active bin is
 * excluded — the CDPM contract forbids placing orders on the currently active
 * bin (minimum spread = 2×bin_step per §1.3).
 *
 * Returns a Map<binId, weight> normalized to sum 1.
 */
function computeNormalWeights(
  centerBin: number,
  activeBin: number,
  halfWidth: number,
  widthSigma: number,
  pmLower: number,
  pmUpper: number,
): Map<number, number> {
  const lo = Math.max(centerBin - halfWidth, pmLower);
  const hi = Math.min(centerBin + halfWidth, pmUpper);

  const raw = new Map<number, number>();
  let total = 0;
  for (let k = lo; k <= hi; k++) {
    if (k === activeBin) continue; // never place on active bin
    const w = gaussianWeight(k, centerBin, widthSigma);
    if (w > 0) {
      raw.set(k, w);
      total += w;
    }
  }
  if (total <= 0 || raw.size === 0) return new Map();

  const normalized = new Map<number, number>();
  for (const [k, w] of raw) normalized.set(k, w / total);
  return normalized;
}

/**
 * Compute per-bin weight vector for TREND state.
 *
 * Direction convention: `trendBias > 0` = bullish on the BASE asset (human
 * pair price rising). In BIN space the price moves by `dir =
 * binDirection(orientation)` per unit of human-price rise — on an inverted
 * pool (physical coinA = quote) a bullish move DECREASES the bin id. All side
 * selections below are expressed via `dir` so both orientations behave
 * identically in economic terms.
 *
 * Two regimes with deliberately different direction semantics (F9):
 *
 * Weak trend (|trendBias| ≤ strong threshold):
 *   Normal-shaped weights around active bin, with a skew boosting the bins
 *   the price is expected to move INTO (they hold the inventory that fills as
 *   the move continues) and shrinking the opposite side.
 *   NOTE: whether to follow or fade the trend at weak-bias levels is to be
 *   validated in the W5 grid search / shadow data.
 *
 * Strong trend (|trendBias| > strong threshold):
 *   Only 1–3 bins on the *counter-trend* side (25 % of market capital;
 *   the rest to lending) — positioned for a potential reversal.
 *   NOTE: the follow↔fade switch at the strong-bias boundary is a deliberate
 *   design choice that warrants validation in W5 grid search / shadow data.
 */
function computeTrendWeights(
  activeBin: number,
  trendBias: number,
  halfWidth: number,
  widthSigma: number,
  pmLower: number,
  pmUpper: number,
  strongTrend: boolean,
  dir: 1 | -1,
): { weights: Map<number, number>; strongTrend: boolean } {
  // strongTrend is derived by the state machine (|trendBias| > stateParams.
  // trendBiasStrong) and passed in via ctx — no local re-derivation, so a
  // config override of the threshold reaches this regime switch too.

  // Bin-space direction of the expected move: sign(trendBias) in human price,
  // mapped through the pool orientation.
  const moveSign = Math.sign(trendBias) * dir;

  if (strongTrend) {
    // Counter-trend side = opposite to the expected move.
    const counterAbove = moveSign < 0;
    const bins: number[] = [];
    if (counterAbove) {
      for (let k = activeBin + 1; k <= Math.min(activeBin + 3, pmUpper); k++) bins.push(k);
    } else {
      for (let k = activeBin - 1; k >= Math.max(activeBin - 3, pmLower); k--) bins.push(k);
    }
    if (bins.length === 0) return { weights: new Map(), strongTrend: true };
    const w = 1 / bins.length;
    const weights = new Map<number, number>(bins.map((k) => [k, w]));
    return { weights, strongTrend: true };
  }

  // Weak trend: symmetric range around active, then bias-skew applied.
  const lo = Math.max(activeBin - halfWidth, pmLower);
  const hi = Math.min(activeBin + halfWidth, pmUpper);

  const skew = 0.3 * Math.abs(trendBias);
  const raw = new Map<number, number>();
  let total = 0;
  for (let k = lo; k <= hi; k++) {
    if (k === activeBin) continue;
    let w = gaussianWeight(k, activeBin, widthSigma);
    // Boost the bins in the path of the expected move; shrink the others.
    const binSide = Math.sign(k - activeBin);
    if (moveSign !== 0) {
      w *= binSide === moveSign ? 1 + skew : 1 - skew;
    }
    if (w > 0) {
      raw.set(k, w);
      total += w;
    }
  }
  if (total <= 0 || raw.size === 0) return { weights: new Map(), strongTrend: false };

  const normalized = new Map<number, number>();
  for (const [k, w] of raw) normalized.set(k, w / total);
  return { weights: normalized, strongTrend: false };
}

// ---------------------------------------------------------------------------
// Implied weight from current position
// ---------------------------------------------------------------------------

/**
 * Convert the current position (positionBins) to an implied weight map.
 *
 * We use liquidityShare as a proxy for capital; this is an approximation
 * (shares have different bin prices), but sufficient for shape-deviation
 * comparison since both target and current are normalized the same way.
 */
function currentPositionWeights(pm: PMState): Map<number, number> {
  const total = pm.positionBins.reduce((s, b) => s + b.liquidityShare, 0n);
  if (total === 0n) return new Map();
  const out = new Map<number, number>();
  for (const b of pm.positionBins) {
    if (b.liquidityShare > 0n) out.set(b.binId, Number(b.liquidityShare) / Number(total));
  }
  return out;
}

/**
 * Compute L1 shape deviation between two weight maps (both normalized).
 *
 * sum of |target[k] - current[k]| across all bins in the union.
 * Range [0, 2]: 0 = identical, 2 = completely disjoint.
 * A deviation of 0.15 means 15 % of the total probability mass has shifted.
 */
function shapeDeviation(target: Map<number, number>, current: Map<number, number>): number {
  const allBins = new Set([...target.keys(), ...current.keys()]);
  let sum = 0;
  for (const k of allBins) {
    const tw = target.get(k) ?? 0;
    const cw = current.get(k) ?? 0;
    sum += Math.abs(tw - cw);
  }
  return sum;
}

// ---------------------------------------------------------------------------
// Amount splitting
// ---------------------------------------------------------------------------

/**
 * Split `total` (bigint) proportionally across bins by weight.
 * Distributes rounding dust onto the highest-weight bin.
 */
function splitProportional(total: bigint, weights: number[]): bigint[] {
  if (weights.length === 0) return [];
  if (total === 0n) return weights.map(() => 0n);

  const sum = weights.reduce((s, w) => s + w, 0);
  if (sum <= 0) {
    const per = total / BigInt(weights.length);
    const out = weights.map(() => per);
    const last = out.length - 1;
    if (last >= 0) out[last] = total - per * BigInt(weights.length - 1);
    return out;
  }

  const SCALE = 1_000_000_000n;
  const scaled = weights.map((w) => BigInt(Math.round((w / sum) * Number(SCALE))));
  const scaledSum = scaled.reduce((s, v) => s + v, 0n);

  const parts = scaled.map((s) => (scaledSum > 0n ? (total * s) / scaledSum : 0n));

  // Distribute rounding dust to the largest-weight bin.
  let allocated = parts.reduce((s, v) => s + v, 0n);
  if (allocated < total) {
    const maxIdx = weights.reduce((mi, w, i) => (w > (weights[mi] ?? 0) ? i : mi), 0);
    parts[maxIdx] = (parts[maxIdx] ?? 0n) + (total - allocated);
    allocated = total;
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Ask minimum-price filter
// ---------------------------------------------------------------------------

/**
 * Ask-minimum-price filter for BASE-selling bins.
 *
 * "Asks" are the bins holding the BASE asset — they fill by selling base as
 * the human price rises into them. Which physical side that is depends on the
 * pool orientation: bins above active hold physical coinA, so asks are the
 * ABOVE side on a normal pool and the BELOW side on an inverted pool
 * (physical coinA = quote → base = physical coinB = below-active bins).
 *
 * Per decision-engine-design.md §4.3:
 *   ask_min_price = avg_cost_basis × (1 + 2×fee + min_profit)
 *
 * Since we don't track cost basis in this pure function (it is tracked in
 * inventory.ts), we use the current active-bin human price as a proxy for
 * cost. A bin whose effective fill price is below the break-even threshold is
 * skipped.
 *
 * Returns true if the bin should be included (passes the ask-min filter).
 */
function passesAskMinFilter(
  binId: number,
  activeBinId: number,
  orientation: PoolOrientation,
  feeRateBps: number,
): boolean {
  // Ask side in bin space: the direction of RISING human price.
  const dir = binDirection(orientation);
  const isAskBin = Math.sign(binId - activeBinId) === dir;
  if (!isAskBin) return true;

  const binPriceNum = humanPriceForBin(orientation, binId);
  const activePriceNum = humanPriceForBin(orientation, activeBinId);
  if (!Number.isFinite(binPriceNum) || !Number.isFinite(activePriceNum) || activePriceNum <= 0) {
    return true; // Can't compute — allow through rather than erroneously blocking
  }

  // The ask order at binId fills when market crosses binPrice × (1 + fee).
  // The LP's implied cost basis proxy = activePriceNum (current mid).
  // ask_min_price = activePriceNum × (1 + 2×fee + min_profit)
  const feeDecimal = feeRateBps / 10_000;
  const askMinPrice = activePriceNum * (1 + 2 * feeDecimal + ASK_MIN_PROFIT_FRAC);

  // The effective fill price of this bin must exceed askMinPrice.
  const effectiveFill = binPriceNum * (1 + feeDecimal);
  return effectiveFill >= askMinPrice;
}

// ---------------------------------------------------------------------------
// Fill probability for gas budget ranking
// ---------------------------------------------------------------------------

/**
 * Fill probability of a bin given the prediction distribution.
 * Uses the normal PDF at the bin's offset from the predicted center:
 *   fill_prob(k) = normal_pdf((k - center) / widthSigma)
 * Normalized by the PDF at the center so the closest bin always has weight 1.
 *
 * Used to rank bins by expected revenue when shrinking the plan for PTB limit.
 */
function fillProb(k: number, centerBin: number, widthSigma: number): number {
  if (widthSigma <= 0) return k === centerBin ? 1 : 0;
  const z = (k - centerBin) / widthSigma;
  // normal PDF(0) = 1/sqrt(2π), so relative fill_prob is just exp(-z²/2).
  return Math.exp(-0.5 * z * z);
}

// ---------------------------------------------------------------------------
// PTB shrink: trim the plan to satisfy PTB ≤ 6 ops
// ---------------------------------------------------------------------------

/**
 * Given a candidate set of add-bins with their weights, trim the lowest-value
 * bins until `countPlanOps(plan, pm) ≤ PTB_MAX_OPS`.
 *
 * Strategy: the add_liquidity call itself is a single PTB op regardless of how
 * many bins it covers. The constraint is on the *number of CDPM method calls*,
 * not the number of bins inside a single call.
 *
 * So the only way the add op contributes more than 1 op is if we somehow
 * split across multiple add calls — but txUnified always issues a single
 * agent_add_liquidity call. The real risk is having too many ops from
 * collect + remove + transfer_A + transfer_B + add = 5 ops, which is already
 * within the 6-op limit.
 *
 * The 6-op budget becomes binding when lending redeems/supplies are included
 * (each is a separate PTB op). Since diffPlan doesn't know about lending
 * decisions, we export `countPlanOps` so the caller can check the full budget.
 * For the plan itself, we ensure the plan-only op count does not exceed
 * PTB_MAX_OPS on its own (leaving 0+ ops for lending).
 *
 * If the plan's own ops already exceed PTB_MAX_OPS, we shrink by dropping
 * the `add` step entirely (extreme case: only remove, no re-add this tick).
 * The bins argument is sorted descending by expected_revenue to retain the
 * most valuable bins.
 */
function shrinkToFitPtb(
  candidateBins: number[],
  candidateWeights: number[],
  pm: PMState,
  collectFees: boolean,
  removeShares: Map<number, bigint>,
  centerBin: number,
  widthSigma: number,
): { bins: number[]; weights: number[] } {
  // Sort bins descending by fill probability (expected revenue proxy).
  const indexed = candidateBins.map((k, i) => ({
    k,
    w: candidateWeights[i] ?? 0,
    fp: fillProb(k, centerBin, widthSigma),
  }));
  indexed.sort((a, b) => b.fp - a.fp);

  // Compute current plan ops assuming all candidate bins are included.
  const opsFixed = computeFixedOps(pm, collectFees, removeShares);
  // add_liquidity is always 1 op if there are any bins.
  const totalOps = opsFixed + (indexed.length > 0 ? 1 : 0);

  if (totalOps <= PTB_MAX_OPS) {
    // No shrinking needed — return in original order.
    return { bins: candidateBins, weights: candidateWeights };
  }

  // The only way to reduce ops here is to drop the add step entirely (since
  // add_liquidity is always 1 op regardless of bin count).
  // Return empty bins — this tick only removes/collects.
  return { bins: [], weights: [] };
}

/**
 * Count the "fixed" ops that don't depend on the number of add bins.
 * Excludes add_liquidity itself.
 */
function computeFixedOps(
  pm: PMState,
  collectFees: boolean,
  removeShares: Map<number, bigint>,
): number {
  let ops = 0;
  const hasFeeBag = pm.feeBag.a > 0n || pm.feeBag.b > 0n;
  if (collectFees || hasFeeBag) ops++;
  if (removeShares.size > 0) ops++;
  if (pm.feeBag.a > 0n) ops++;
  if (pm.feeBag.b > 0n) ops++;
  return ops;
}

// ---------------------------------------------------------------------------
// PM range helpers
// ---------------------------------------------------------------------------

/**
 * Derive the PM's allowed bin range from the current position.
 * If no position exists, use a wide default around the active bin.
 *
 * The CDPM contract restricts operations to [lowerBin, upperBin] of the
 * position NFT. Without on-chain read (this is a pure function), we infer the
 * range from existing positionBins or use a ±halfWidth default.
 */
function pmRange(pm: PMState, activeBin: number, halfWidth: number): { lower: number; upper: number } {
  if (pm.positionBins.length > 0) {
    const lower = pm.positionBins.reduce((m, b) => Math.min(m, b.binId), pm.positionBins[0]!.binId);
    const upper = pm.positionBins.reduce((m, b) => Math.max(m, b.binId), pm.positionBins[0]!.binId);
    // Extend if the new target center + halfWidth is outside the current range.
    return {
      lower: Math.min(lower, activeBin - halfWidth),
      upper: Math.max(upper, activeBin + halfWidth),
    };
  }
  // No existing position — use ±halfWidth around active.
  return { lower: activeBin - halfWidth, upper: activeBin + halfWidth };
}

// ---------------------------------------------------------------------------
// Emergency full-withdrawal plan
// ---------------------------------------------------------------------------

/**
 * Build the EXTREME full-withdrawal plan: remove every bin's shares, collect
 * fees when present, add nothing. Returns null when there is neither an open
 * position nor uncollected fees (nothing to protect).
 *
 * Shared by:
 *   - diffPlan's EXTREME branch (state-machine-driven, mlAgent path)
 *   - mlAgent's fallback branch when an L2 veto is active during sidecar
 *     degradation (the fallback strategy has no EXTREME concept)
 *   - the rebalancer's rule-strategy pre-tick L2 veto path
 *
 * `reason` overrides the journal string; callers should include the trigger.
 */
export function buildExtremeWithdrawPlan(
  pm: PMState,
  reason = "EXTREME: full withdrawal",
): RebalancePlan | null {
  const hasFees = pm.feeBag.a > 0n || pm.feeBag.b > 0n;
  const hasPosition = pm.positionBins.length > 0;
  if (!hasPosition && !hasFees) return null;

  const removeShares = new Map<number, bigint>();
  for (const b of pm.positionBins) {
    if (b.liquidityShare > 0n) removeShares.set(b.binId, b.liquidityShare);
  }

  return {
    pmId: pm.pmId,
    removeShares,
    addAmountA: 0n,
    addAmountB: 0n,
    addBins: [],
    addAmountsA: [],
    addAmountsB: [],
    collectFees: hasFees,
    reason,
    priority: "emergency",
  };
}

// ---------------------------------------------------------------------------
// Core diffPlan function
// ---------------------------------------------------------------------------

/**
 * Compute the minimum RebalancePlan to move the liquidity distribution toward
 * the target derived from the prediction + state context.
 *
 * Returns null when:
 *   - The position is already within toleranceBins of the target center AND
 *     the shape deviation is below MIN_SHAPE_DEVIATION (quiet signal).
 *   - The PM has no capital and no position to work with.
 *
 * Returns a full-withdrawal plan (removeAll, no add) for EXTREME state.
 */
export function diffPlan(input: DiffPlanInput): RebalancePlan | null {
  const { pm, pool, ctx, pred, profile, stopLoss } = input;

  const activeBin = pool.activeBinId;
  const orientation = orientationOf(profile);
  const dir = binDirection(orientation);
  const hasForceLiquidation = (stopLoss?.forceLiquidationBins.length ?? 0) > 0;

  /**
   * Ask-min-filter exemption for stop-loss bins: forced-liquidation bins are
   * always exempt; when a relaxed floor is set, every ask-side bin at or
   * beyond it (in the rising-price direction) is exempt too — the relaxed
   * floor is the operative minimum.
   */
  const stopLossExempt = (k: number): boolean => {
    if (!stopLoss) return false;
    if (stopLoss.forceLiquidationBins.includes(k)) return true;
    const floor = stopLoss.relaxedAskFloorBin;
    if (floor === null) return false;
    // Beyond-or-at the floor in the +dir (rising human price) direction.
    return dir === 1 ? k >= floor : k <= floor;
  };
  const hasFees = pm.feeBag.a > 0n || pm.feeBag.b > 0n;
  const hasBalance = pm.balance.a > 0n || pm.balance.b > 0n;
  const hasPosition = pm.positionBins.length > 0;

  // Nothing to do when empty.
  if (!hasBalance && !hasPosition && !hasFees) return null;

  // --- EXTREME: full withdrawal, no re-add ---
  if (ctx.state === "EXTREME") {
    return buildExtremeWithdrawPlan(pm);
  }

  // --- maxCenterOffset: read directly from ctx (F5) ---
  // The state machine populates ctx.maxCenterOffset via deriveMaxCenterOffset(),
  // which handles the uncertainty-high path (featureCompleteness < U_HIGH → 1 bin)
  // and the normal path (clamp(round(widthSigma), 1, 3)).
  // diffPlanner no longer re-derives this value — the state machine is the
  // single source of truth (eliminates the local re-derivation that had no
  // uncertainty input and used toleranceBins as a proxy).
  const maxCenterOffset = ctx.maxCenterOffset;

  // --- NORMAL: center derived from predicted offset ---
  // --- TREND:  center = active bin (don't follow moving target) ---
  let targetCenterBin: number;
  if (ctx.state === "NORMAL") {
    const rawOffset = Math.round(pred.centerOffset);
    const clippedOffset = Math.max(-maxCenterOffset, Math.min(maxCenterOffset, rawOffset));
    targetCenterBin = activeBin + clippedOffset;
  } else {
    // TREND: center is always active bin per §3.2
    targetCenterBin = activeBin;
  }

  // --- Inventory imbalance assessment (C1 wiring) ---
  // Computed on the FULL deployable capital (incl. any injected positionValue)
  // — capitalScale multiplies both sides equally so the overage ratio is
  // scale-invariant. Values are converted through the PHYSICAL mid-price.
  const invGrossA = pm.balance.a + pm.feeBag.a + (pm.positionValue?.a ?? 0n);
  const invGrossB = pm.balance.b + pm.feeBag.b + (pm.positionValue?.b ?? 0n);
  const physicalOrientation: PoolOrientation = { ...orientation, poolCoinAIsQuote: false };
  const invAdj: InventoryAdjustment = computeInventoryAdjustment({
    availableA: invGrossA,
    availableB: invGrossB,
    midPriceNum: humanPriceForBin(physicalOrientation, activeBin),
    decimalAdj: Math.pow(10, orientation.poolCoinADecimals - orientation.poolCoinBDecimals),
  });

  // --- Tolerance check: is the current position already good enough? ---
  const currentPositionCenter: number | null = (() => {
    if (!hasPosition) return null;
    const min = pm.positionBins.reduce((m, b) => Math.min(m, b.binId), pm.positionBins[0]!.binId);
    const max = pm.positionBins.reduce((m, b) => Math.max(m, b.binId), pm.positionBins[0]!.binId);
    return Math.round((min + max) / 2);
  })();

  // A severe imbalance OR a pending force-liquidation mandates a correction
  // pass even when the position shape looks fine — the severe regime's
  // bypassGasFilter flag and §4.2's stale-inventory exception are exactly
  // these two exceptions.
  if (hasPosition && currentPositionCenter !== null && !invAdj.bypassGasFilter && !hasForceLiquidation) {
    const centerDrift = Math.abs(currentPositionCenter - targetCenterBin);
    if (centerDrift <= ctx.toleranceBins) {
      // Center is close enough — check shape deviation.
      let targetWeights: Map<number, number>;
      const { lower: pmLo, upper: pmHi } = pmRange(pm, activeBin, ctx.halfWidth);

      if (ctx.state === "TREND") {
        const { weights } = computeTrendWeights(
          activeBin,
          ctx.trendBias,
          ctx.halfWidth,
          pred.widthSigma,
          pmLo,
          pmHi,
          ctx.strongTrend,
          dir,
        );
        targetWeights = weights;
      } else {
        targetWeights = computeNormalWeights(
          targetCenterBin,
          activeBin,
          ctx.halfWidth,
          pred.widthSigma,
          pmLo,
          pmHi,
        );
      }

      const current = currentPositionWeights(pm);
      const deviation = shapeDeviation(targetWeights, current);
      if (deviation < MIN_SHAPE_DEVIATION) {
        return null; // Below min-improvement threshold — quiet
      }
    }
  }

  // --- Build target weight map ---
  const { lower: pmLower, upper: pmUpper } = pmRange(pm, activeBin, ctx.halfWidth);

  let targetWeights: Map<number, number>;
  let isStrongTrend = false;
  let capitalScale = 1.0; // fraction of market capital to deploy

  if (ctx.state === "TREND") {
    const { weights, strongTrend } = computeTrendWeights(
      activeBin,
      ctx.trendBias,
      ctx.halfWidth,
      pred.widthSigma,
      pmLower,
      pmUpper,
      ctx.strongTrend,
      dir,
    );
    targetWeights = weights;
    isStrongTrend = strongTrend;
    if (isStrongTrend) {
      // Strong trend: only 25 % of market capital is deployed.
      capitalScale = 0.25;
    }
  } else {
    // NORMAL
    targetWeights = computeNormalWeights(
      targetCenterBin,
      activeBin,
      ctx.halfWidth,
      pred.widthSigma,
      pmLower,
      pmUpper,
    );
  }

  // --- Remove all current position (rebuild from scratch) ---
  // We always remove everything and re-add the new distribution. This is
  // consistent with how multiBinSpot works and avoids complex diff logic
  // that would need to handle per-bin amount alignment.
  const removeShares = new Map<number, bigint>();
  for (const b of pm.positionBins) {
    if (b.liquidityShare > 0n) removeShares.set(b.binId, b.liquidityShare);
  }

  // --- Build add bins, respecting ask-min filter ---
  // Principal capital = idle balance + the dryRun-estimated value of the
  // position being removed (injected by the execution layer's re-plan pass);
  // capitalScale (strong-trend 25 %) applies to principal, fees ride on top.
  const principalA = pm.balance.a + (pm.positionValue?.a ?? 0n);
  const principalB = pm.balance.b + (pm.positionValue?.b ?? 0n);
  const marketCapitalA = BigInt(Math.floor(Number(principalA) * capitalScale));
  const marketCapitalB = BigInt(Math.floor(Number(principalB) * capitalScale));

  // Include fee bag in available capital.
  const availableA = marketCapitalA + pm.feeBag.a;
  const availableB = marketCapitalB + pm.feeBag.b;

  const candidateBins: number[] = [];
  const candidateWeights: number[] = [];

  for (const [k, w] of targetWeights) {
    // Apply ask-min filter (skip ask-side bins that can't meet min profit),
    // unless a stop-loss directive exempts this bin (relaxed floor / forced).
    if (!stopLossExempt(k) && !passesAskMinFilter(k, activeBin, orientation, pool.feeRateBps)) {
      continue;
    }
    candidateBins.push(k);
    candidateWeights.push(w);
  }

  // Force-liquidation bins MUST be candidates even when the target weights
  // didn't cover them (e.g. a tight halfWidth). Weight = the current max so
  // the proportional split parks a meaningful share of the stale side there.
  if (stopLoss) {
    const maxW = candidateWeights.reduce((m, w) => Math.max(m, w), 0) || 1;
    for (const k of stopLoss.forceLiquidationBins) {
      if (k === activeBin) continue; // never place on active
      if (!candidateBins.includes(k)) {
        candidateBins.push(k);
        candidateWeights.push(maxW);
      }
    }
  }

  // --- PTB shrink if needed ---
  const collectFees = hasFees;
  const { bins: finalBins, weights: finalWeights } = shrinkToFitPtb(
    candidateBins,
    candidateWeights,
    pm,
    collectFees,
    removeShares,
    targetCenterBin,
    pred.widthSigma,
  );

  // If nothing to add and nothing to remove (and no fees), return null.
  if (finalBins.length === 0 && removeShares.size === 0 && !hasFees) return null;

  // --- Split available capital across bins by PHYSICAL side ---
  // Verified on mainnet (scripts/probe-bin-orientation.ts): bins ABOVE the
  // active bin hold physical coinA only; bins BELOW hold physical coinB only.
  const aboveBins: number[] = [];
  const aboveWeights: number[] = [];
  const belowBins: number[] = [];
  const belowWeights: number[] = [];

  for (let i = 0; i < finalBins.length; i++) {
    const k = finalBins[i]!;
    const w = finalWeights[i] ?? 0;
    if (k > activeBin) {
      aboveBins.push(k);
      aboveWeights.push(w);
    } else if (k < activeBin) {
      belowBins.push(k);
      belowWeights.push(w);
    }
    // Skip the active bin itself (never place on it).
  }

  // Renormalize side weights independently.
  const aboveSum = aboveWeights.reduce((s, w) => s + w, 0);
  const belowSum = belowWeights.reduce((s, w) => s + w, 0);
  const normAboveWeights = aboveSum > 0 ? aboveWeights.map((w) => w / aboveSum) : aboveWeights;
  const normBelowWeights = belowSum > 0 ? belowWeights.map((w) => w / belowSum) : belowWeights;

  const aboveAmounts = splitProportional(availableA, normAboveWeights);
  const belowAmounts = splitProportional(availableB, normBelowWeights);

  // Merge back into ordered output arrays (dust filter applied AFTER the
  // inventory correction below — scaling can push amounts under the floor).
  const allBins: number[] = [];
  const allAmountsA: bigint[] = [];
  const allAmountsB: bigint[] = [];

  for (let i = 0; i < aboveBins.length; i++) {
    allBins.push(aboveBins[i]!);
    allAmountsA.push(aboveAmounts[i] ?? 0n);
    allAmountsB.push(0n);
  }
  for (let i = 0; i < belowBins.length; i++) {
    allBins.push(belowBins[i]!);
    allAmountsA.push(0n);
    allAmountsB.push(belowAmounts[i] ?? 0n);
  }

  // --- Inventory correction pass (C1) ---
  // Scale the overweight side down (×0.7 / ×0 per regime); scale-ups are
  // clamped back to available, so on the fully-deployed split they are a
  // no-op — the meaningful effect is the reduction of the overweight side
  // (the excess stays idle and is swept to lending, the only inventory
  // response available to an agent that cannot swap).
  const { adjustedA, adjustedB } = applyInventoryScales(
    allBins,
    allAmountsA,
    allAmountsB,
    activeBin,
    invAdj,
  );
  const { clampedA, clampedB } = clampToAvailable(adjustedA, adjustedB, availableA, availableB);

  // Dust filter + ascending sort (required by CDPM contract).
  const keptIdx = allBins
    .map((_, i) => i)
    .filter((i) => (clampedA[i] ?? 0n) >= MIN_BIN_AMOUNT || (clampedB[i] ?? 0n) >= MIN_BIN_AMOUNT);
  keptIdx.sort((a, b) => (allBins[a] ?? 0) - (allBins[b] ?? 0));
  const sortedBins = keptIdx.map((i) => allBins[i]!);
  const sortedAmountsA = keptIdx.map((i) => ((clampedA[i] ?? 0n) >= MIN_BIN_AMOUNT ? clampedA[i]! : 0n));
  const sortedAmountsB = keptIdx.map((i) => ((clampedB[i] ?? 0n) >= MIN_BIN_AMOUNT ? clampedB[i]! : 0n));

  const totalAddA = sortedAmountsA.reduce((s, v) => s + v, 0n);
  const totalAddB = sortedAmountsB.reduce((s, v) => s + v, 0n);

  const stateLabel = ctx.state === "TREND" ? (isStrongTrend ? "TREND/strong" : "TREND/weak") : "NORMAL";
  const stopLossTag = stopLoss
    ? `${stopLoss.forceLiquidationBins.length > 0 ? ` stopLoss=force@${stopLoss.forceLiquidationBins.join("/")}` : ""}${stopLoss.relaxedAskFloorBin !== null ? ` stopLoss=relax@${stopLoss.relaxedAskFloorBin}` : ""}`
    : "";
  const reason = `diffPlan: ${stateLabel} center=${targetCenterBin} active=${activeBin} bins=${sortedBins.length} halfWidth=${ctx.halfWidth} trendBias=${ctx.trendBias.toFixed(2)} inv=${invAdj.regime}${invAdj.regime !== "balanced" ? ` overage=${invAdj.suiOverage.toFixed(2)}` : ""}${stopLossTag}`;

  return {
    pmId: pm.pmId,
    removeShares,
    addAmountA: totalAddA,
    addAmountB: totalAddB,
    addBins: sortedBins,
    addAmountsA: sortedAmountsA,
    addAmountsB: sortedAmountsB,
    collectFees,
    reason,
    plannedActiveBinId: activeBin,
  };
}
