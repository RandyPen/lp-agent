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
import { priceFromBinId } from "../domain/binMath.ts";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface DiffPlanInput {
  pm: PMState;
  pool: PoolState;
  ctx: StateContext;
  pred: PredictionResponse;
  profile: PoolProfile;
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
 * Two regimes with deliberately different direction semantics (F9):
 *
 * Weak trend (|trendBias| ≤ 0.7):
 *   Normal-shaped weights around active bin, with directional skew applied:
 *     k < activeBin (bid side): w *= (1 + 0.3 × trendBias)
 *     k > activeBin (ask side): w *= (1 - 0.3 × trendBias)
 *   When trendBias > 0 (bullish): BIDS are boosted (more coinA placed below active).
 *   This provides liquidity on the anticipated continuation side — i.e. we expect
 *   the price to move up, so we hold more bid inventory to be sold as price rises.
 *   NOTE: this "follow-trend" direction (boosting the side in the trend direction)
 *   is the OPPOSITE of a counter-trend positioning. Whether to follow or fade the
 *   trend at weak-bias levels is to be validated in the W5 grid search / shadow data.
 *
 * Strong trend (|trendBias| > 0.7):
 *   Only 1–3 bins on the *counter-trend* side (25 % of market capital; 75 % to lending).
 *   trendBias > 0 (bullish) → counter-trend = bid side (below active), preparing for
 *     a potential reversal by holding liquidity below current price.
 *   trendBias < 0 (bearish) → counter-trend = ask side (above active).
 *   NOTE: this "fade-the-trend" direction at strong bias (|bias|>0.7) is intentionally
 *   opposite to the weak-trend regime's "follow-trend" boost. The switch in direction
 *   semantics at the |bias|=0.7 boundary is a deliberate design choice that warrants
 *   validation in W5 grid search / shadow data.
 */
function computeTrendWeights(
  activeBin: number,
  trendBias: number,
  halfWidth: number,
  widthSigma: number,
  pmLower: number,
  pmUpper: number,
): { weights: Map<number, number>; strongTrend: boolean } {
  const absB = Math.abs(trendBias);
  const strongTrend = absB > 0.7;

  if (strongTrend) {
    // Counter-trend: trendBias > 0 (bullish) → counter-trend is bid (below active)
    //                trendBias < 0 (bearish) → counter-trend is ask (above active)
    const counterTrendAbove = trendBias < 0; // bearish → counter is above
    const bins: number[] = [];
    if (counterTrendAbove) {
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

  const raw = new Map<number, number>();
  let total = 0;
  for (let k = lo; k <= hi; k++) {
    if (k === activeBin) continue;
    let w = gaussianWeight(k, activeBin, widthSigma);
    // Apply directional bias: trendBias > 0 (bullish) → boost bid side (k < active)
    if (k < activeBin) w *= 1 + 0.3 * trendBias;
    else w *= 1 - 0.3 * trendBias;
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
 * Compute the ask minimum price for a bin (bin is above active bin = LP sells A).
 *
 * Per decision-engine-design.md §4.3:
 *   ask_min_price = avg_cost_basis × (1 + 2×fee + min_profit)
 *
 * Since we don't track cost basis in this pure function (it is tracked in
 * inventory.ts), we use the current bin price as a proxy for cost.
 * A bin whose price is below the break-even threshold is skipped.
 *
 * Returns true if the bin should be included (passes the ask-min filter).
 */
function passesAskMinFilter(
  binId: number,
  activeBinId: number,
  binStep: number,
  decimalsA: number,
  decimalsB: number,
  feeRateBps: number,
): boolean {
  // Only ask-side bins (above active) are subject to the ask-min filter.
  if (binId <= activeBinId) return true;

  const binPriceNum = Number(priceFromBinId(binId, binStep, decimalsA, decimalsB));
  const activePriceNum = Number(priceFromBinId(activeBinId, binStep, decimalsA, decimalsB));
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
  const { pm, pool, ctx, pred, profile } = input;

  const activeBin = pool.activeBinId;
  const hasFees = pm.feeBag.a > 0n || pm.feeBag.b > 0n;
  const hasBalance = pm.balance.a > 0n || pm.balance.b > 0n;
  const hasPosition = pm.positionBins.length > 0;

  // Nothing to do when empty.
  if (!hasBalance && !hasPosition && !hasFees) return null;

  // --- EXTREME: full withdrawal, no re-add ---
  if (ctx.state === "EXTREME") {
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
      reason: "EXTREME: full withdrawal",
    };
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

  // --- Tolerance check: is the current position already good enough? ---
  const currentPositionCenter: number | null = (() => {
    if (!hasPosition) return null;
    const min = pm.positionBins.reduce((m, b) => Math.min(m, b.binId), pm.positionBins[0]!.binId);
    const max = pm.positionBins.reduce((m, b) => Math.max(m, b.binId), pm.positionBins[0]!.binId);
    return Math.round((min + max) / 2);
  })();

  if (hasPosition && currentPositionCenter !== null) {
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
  const marketCapitalA = BigInt(Math.floor(Number(pm.balance.a) * capitalScale));
  const marketCapitalB = BigInt(Math.floor(Number(pm.balance.b) * capitalScale));

  // Include fee bag in available capital.
  const availableA = marketCapitalA + pm.feeBag.a;
  const availableB = marketCapitalB + pm.feeBag.b;

  const candidateBins: number[] = [];
  const candidateWeights: number[] = [];

  for (const [k, w] of targetWeights) {
    // Apply ask-min filter (skip ask-side bins that can't meet min profit).
    if (
      !passesAskMinFilter(
        k,
        activeBin,
        profile.binStep,
        profile.decimalsA,
        profile.decimalsB,
        pool.feeRateBps,
      )
    ) {
      continue;
    }
    candidateBins.push(k);
    candidateWeights.push(w);
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

  // --- Split available capital across bins by side ---
  const bidBins: number[] = [];
  const bidWeights: number[] = [];
  const askBins: number[] = [];
  const askWeights: number[] = [];

  for (let i = 0; i < finalBins.length; i++) {
    const k = finalBins[i]!;
    const w = finalWeights[i] ?? 0;
    if (k < activeBin) {
      bidBins.push(k);
      bidWeights.push(w);
    } else if (k > activeBin) {
      askBins.push(k);
      askWeights.push(w);
    }
    // Skip the active bin itself (CDPM constraint).
  }

  // Renormalize side weights independently.
  const bidSum = bidWeights.reduce((s, w) => s + w, 0);
  const askSum = askWeights.reduce((s, w) => s + w, 0);
  const normBidWeights = bidSum > 0 ? bidWeights.map((w) => w / bidSum) : bidWeights;
  const normAskWeights = askSum > 0 ? askWeights.map((w) => w / askSum) : askWeights;

  const bidAmounts = splitProportional(availableA, normBidWeights);
  const askAmounts = splitProportional(availableB, normAskWeights);

  // Merge back into ordered output arrays, filtering dust.
  const allBins: number[] = [];
  const allAmountsA: bigint[] = [];
  const allAmountsB: bigint[] = [];

  for (let i = 0; i < bidBins.length; i++) {
    const k = bidBins[i]!;
    const a = bidAmounts[i] ?? 0n;
    if (a >= MIN_BIN_AMOUNT) {
      allBins.push(k);
      allAmountsA.push(a);
      allAmountsB.push(0n);
    }
  }
  for (let i = 0; i < askBins.length; i++) {
    const k = askBins[i]!;
    const b = askAmounts[i] ?? 0n;
    if (b >= MIN_BIN_AMOUNT) {
      allBins.push(k);
      allAmountsA.push(0n);
      allAmountsB.push(b);
    }
  }

  // Sort bins ascending (required by CDPM contract).
  const sortedIdx = allBins.map((_, i) => i).sort((a, b) => (allBins[a] ?? 0) - (allBins[b] ?? 0));
  const sortedBins = sortedIdx.map((i) => allBins[i]!);
  const sortedAmountsA = sortedIdx.map((i) => allAmountsA[i] ?? 0n);
  const sortedAmountsB = sortedIdx.map((i) => allAmountsB[i] ?? 0n);

  const totalAddA = sortedAmountsA.reduce((s, v) => s + v, 0n);
  const totalAddB = sortedAmountsB.reduce((s, v) => s + v, 0n);

  const stateLabel = ctx.state === "TREND" ? (isStrongTrend ? "TREND/strong" : "TREND/weak") : "NORMAL";
  const reason = `diffPlan: ${stateLabel} center=${targetCenterBin} active=${activeBin} bins=${sortedBins.length} halfWidth=${ctx.halfWidth} trendBias=${ctx.trendBias.toFixed(2)}`;

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
  };
}
