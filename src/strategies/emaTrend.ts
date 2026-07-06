/**
 * EMA trend strategy.
 *
 * Computes fast/slow EMAs on close-to-close prices (HUMAN pair price,
 * quote-per-base) and biases the deployed bin range toward the trend
 * direction:
 *   - bullish (EMA_fast > EMA_slow × (1 + threshold)): shift the center k bins
 *     in the direction the HUMAN price is rising — in BIN space that is
 *     `binDirection(orientation)` (an inverted pool's bin id FALLS as the
 *     human price rises).
 *   - bearish: the mirror shift.
 *   - neutral: symmetric around the active bin.
 *
 * Weights inside the range are tent-shaped (max at center, linear falloff to
 * the edges) with an additional multiplicative skew on the trend side (the
 * bins the price is expected to move INTO) so the agent captures fees from
 * continued movement before re-pricing.
 *
 * Per-bin coin assignment follows the PHYSICAL side rule (verified on
 * mainnet): bins above active take physical coinA, bins below take coinB;
 * the active bin is never placed on.
 *
 * Like all closed-form forecasters in this template, EMA does not require
 * training — `k = 2/(period+1)` is a fixed decay constant chosen by `period`.
 *
 * Params are configurable via env (see `.env.example` EMA_* block) and default
 * to canonical MACD-style 12/26 on 1-minute spacing.
 */

import type { Strategy, StrategyInput, StrategyOutput } from "./types.ts";
import { binDirection, orientationOf } from "../domain/binMath.ts";
import { log } from "../lib/logger.ts";

export interface EmaTrendParams {
  /** Fast EMA period in bars (default 12). */
  fastPeriod?: number;
  /** Slow EMA period in bars (default 26). */
  slowPeriod?: number;
  /** Min |fast−slow|/slow ratio to call a trend. Default 0.003 (30 bp). */
  trendThreshold?: number;
  /** Half-width in bins of the deployed range (default 5 → 11 bins total). */
  halfWidthBins?: number;
  /** Drift (in bins) from range center that triggers a recenter. */
  driftBinsTrigger?: number;
  /** Skew multiplier applied to trend side of the weight curve. */
  trendSkew?: number;
}

const DEFAULTS: Required<EmaTrendParams> = {
  fastPeriod: 12,
  slowPeriod: 26,
  trendThreshold: 0.003,
  halfWidthBins: 5,
  driftBinsTrigger: 2,
  trendSkew: 1.5,
};

export type EmaTrend = "bullish" | "bearish" | "neutral";

/**
 * Last EMA value for `prices` at `period`. Uses SMA seed for the first
 * `period` observations, then standard EMA update from there.
 * Returns null if input is empty.
 */
export function emaLast(prices: number[], period: number): number | null {
  if (prices.length === 0) return null;
  if (period <= 1) return prices[prices.length - 1] ?? null;
  const seedLen = Math.min(period, prices.length);
  let seed = 0;
  for (let i = 0; i < seedLen; i++) seed += prices[i]!;
  let ema = seed / seedLen;
  if (prices.length <= period) return ema;
  const k = 2 / (period + 1);
  for (let i = period; i < prices.length; i++) {
    ema = prices[i]! * k + ema * (1 - k);
  }
  return ema;
}

export function classifyTrend(
  emaFast: number,
  emaSlow: number,
  threshold: number,
): EmaTrend {
  if (emaSlow <= 0 || !Number.isFinite(emaFast) || !Number.isFinite(emaSlow)) {
    return "neutral";
  }
  const delta = (emaFast - emaSlow) / emaSlow;
  if (delta > threshold) return "bullish";
  if (delta < -threshold) return "bearish";
  return "neutral";
}

/** Split totalRaw into integer parts proportional to weights[i]. */
function splitProportional(totalRaw: bigint, weights: number[]): bigint[] {
  if (weights.length === 0) return [];
  if (totalRaw === 0n) return weights.map(() => 0n);
  const sum = weights.reduce((s, w) => s + w, 0);
  if (sum <= 0) {
    const per = totalRaw / BigInt(weights.length);
    const out = weights.map(() => per);
    out[out.length - 1] = totalRaw - per * BigInt(weights.length - 1);
    return out;
  }
  const scale = 1_000_000_000n;
  const scaled = weights.map((w) => BigInt(Math.floor((w / sum) * Number(scale))));
  const scaledSum = scaled.reduce((s, v) => s + v, 0n);
  const parts: bigint[] = scaled.map((s) => (totalRaw * s) / scaledSum);
  let allocated = parts.reduce((s, v) => s + v, 0n);
  let i = parts.length - 1;
  while (allocated < totalRaw && i >= 0) {
    const w = weights[i];
    if (w !== undefined && w > 0) {
      parts[i] = (parts[i] ?? 0n) + (totalRaw - allocated);
      allocated = totalRaw;
      break;
    }
    i--;
  }
  return parts;
}

export function createEmaTrendStrategy(params: EmaTrendParams = {}): Strategy {
  const p: Required<EmaTrendParams> = { ...DEFAULTS, ...params };

  return {
    name: "emaTrend",

    async plan(input: StrategyInput): Promise<StrategyOutput> {
      const { pm, pool, history, profile } = input;

      const hasBalance = pm.balance.a > 0n || pm.balance.b > 0n;
      const hasPosition = pm.positionBins.length > 0;
      const hasFees = pm.feeBag.a > 0n || pm.feeBag.b > 0n;
      if (!hasBalance && !hasPosition && !hasFees) {
        return { kind: "quiet", reason: "emaTrend: empty PM" };
      }

      const orientation = orientationOf(profile);
      // +1 when the human price rises with bin id, −1 on inverted pools.
      const dir = binDirection(orientation);

      const prices = history
        .map((h) => Number(h.price))
        .filter((v) => Number.isFinite(v) && v > 0);

      let trend: EmaTrend = "neutral";
      let emaFast: number | null = null;
      let emaSlow: number | null = null;
      if (prices.length >= 2) {
        emaFast = emaLast(prices, p.fastPeriod);
        emaSlow = emaLast(prices, p.slowPeriod);
        if (emaFast !== null && emaSlow !== null) {
          trend = classifyTrend(emaFast, emaSlow, p.trendThreshold);
        }
      }

      // Shift the range center toward where the price is heading — in BIN
      // space: bullish = human price rising = bin id moving by `dir`.
      const shiftMag = Math.max(1, Math.floor(p.halfWidthBins / 2));
      const centerOffset =
        trend === "bullish" ? dir * shiftMag : trend === "bearish" ? -dir * shiftMag : 0;
      const center = pool.activeBinId + centerOffset;
      const lower = center - p.halfWidthBins;
      const upper = center + p.halfWidthBins;
      const bins: number[] = [];
      for (let id = lower; id <= upper; id++) bins.push(id);

      // Trigger evaluation.
      const lowestBin = hasPosition
        ? pm.positionBins.reduce(
            (m, b) => (b.binId < m ? b.binId : m),
            pm.positionBins[0]!.binId,
          )
        : null;
      const highestBin = hasPosition
        ? pm.positionBins.reduce(
            (m, b) => (b.binId > m ? b.binId : m),
            pm.positionBins[0]!.binId,
          )
        : null;
      const outOfRange =
        hasPosition &&
        (pool.activeBinId < (lowestBin ?? pool.activeBinId) ||
          pool.activeBinId > (highestBin ?? pool.activeBinId));
      const drift =
        hasPosition && lowestBin !== null && highestBin !== null
          ? Math.abs(
              pool.activeBinId - Math.round((lowestBin + highestBin) / 2),
            )
          : 0;
      const driftTriggered = hasPosition && drift >= p.driftBinsTrigger;
      const shouldRecenter = !hasPosition || outOfRange || driftTriggered;

      if (!shouldRecenter && !hasFees) {
        return {
          kind: "quiet",
          reason: `emaTrend: in range, no fees (trend=${trend})`,
        };
      }

      // Tent weights skewed toward the bins the price is expected to move
      // INTO. Bullish → human price rises → bin id moves by `dir`; the bins
      // on that side of active get the skew multiplier (they hold the
      // inventory that fills as the move continues).
      const trendSign = trend === "bullish" ? 1 : trend === "bearish" ? -1 : 0;
      const weights = bins.map((binId) => {
        const distFromCenter = Math.abs(binId - center);
        const tent = Math.max(0, 1 - distFromCenter / Math.max(p.halfWidthBins, 1));
        const binSide = Math.sign(binId - pool.activeBinId);
        const sideMult =
          trendSign !== 0 && binSide === dir * trendSign ? p.trendSkew : 1;
        return Math.max(tent * sideMult, 1e-6);
      });

      // Split capital by the PHYSICAL side rule: bins above active take
      // physical coinA, bins below take coinB. The active bin is excluded —
      // never place on it (composition-fee policy).
      const removeShares = new Map<number, bigint>();
      if (hasPosition) {
        for (const bin of pm.positionBins) {
          if (bin.liquidityShare > 0n) removeShares.set(bin.binId, bin.liquidityShare);
        }
      }

      // Deployable = idle + fees (when collecting) + dryRun-estimated value of
      // the removed position (injected by the execution layer's re-plan pass).
      const grossA =
        pm.balance.a + (hasFees ? pm.feeBag.a : 0n) + (pm.positionValue?.a ?? 0n);
      const grossB =
        pm.balance.b + (hasFees ? pm.feeBag.b : 0n) + (pm.positionValue?.b ?? 0n);

      const aboveIdx: number[] = [];
      const belowIdx: number[] = [];
      bins.forEach((binId, i) => {
        if (binId > pool.activeBinId) aboveIdx.push(i);
        else if (binId < pool.activeBinId) belowIdx.push(i);
        // active bin: excluded
      });

      const aboveWeights = aboveIdx.map((i) => weights[i] ?? 0);
      const belowWeights = belowIdx.map((i) => weights[i] ?? 0);
      const aboveAmounts = splitProportional(grossA, aboveWeights);
      const belowAmounts = splitProportional(grossB, belowWeights);

      const addAmountsA: bigint[] = bins.map(() => 0n);
      const addAmountsB: bigint[] = bins.map(() => 0n);
      aboveIdx.forEach((i, j) => {
        addAmountsA[i] = aboveAmounts[j] ?? 0n;
      });
      belowIdx.forEach((i, j) => {
        addAmountsB[i] = belowAmounts[j] ?? 0n;
      });

      const finalBins: number[] = [];
      const finalA: bigint[] = [];
      const finalB: bigint[] = [];
      bins.forEach((binId, i) => {
        const a = addAmountsA[i] ?? 0n;
        const b = addAmountsB[i] ?? 0n;
        if (a === 0n && b === 0n) return;
        finalBins.push(binId);
        finalA.push(a);
        finalB.push(b);
      });

      const fastStr = emaFast !== null ? emaFast.toFixed(6) : "n/a";
      const slowStr = emaSlow !== null ? emaSlow.toFixed(6) : "n/a";
      const reason = `emaTrend: ${
        shouldRecenter
          ? outOfRange
            ? "out-of-range"
            : driftTriggered
              ? "drift"
              : "init"
          : "fees-only"
      } trend=${trend} fast=${fastStr} slow=${slowStr} bins=${finalBins.length} center=${center}`;

      if (finalBins.length === 0) {
        log.warn("emaTrend: empty plan after split, going quiet");
        return { kind: "quiet", reason: "emaTrend: empty plan after split" };
      }

      return {
        kind: "plan_and_reconcile",
        plan: {
          pmId: pm.pmId,
          removeShares,
          addAmountA: finalA.reduce((s, v) => s + v, 0n),
          addAmountB: finalB.reduce((s, v) => s + v, 0n),
          addBins: finalBins,
          addAmountsA: finalA,
          addAmountsB: finalB,
          collectFees: hasFees,
          reason,
          plannedActiveBinId: pool.activeBinId,
        },
      };
    },
  };
}
