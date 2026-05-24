/**
 * Multi-bin probabilistic strategy (Phase 1 / v0).
 *
 * Pipeline:
 *   1. Estimate σ from price history (EWMA on close-to-close log returns;
 *      Parkinson if OHLC is available).
 *   2. Pick a bin range ±k·σ around the active bin, capped at MAX_HALF_WIDTH.
 *   3. Integrate a log-normal density across each bin's boundaries to compute
 *      a weight; derate boundary bins by the pool fee dead-zone.
 *   4. Split PM balance into per-bin amounts:
 *        - bid side (id < active): coinA only
 *        - ask side (id > active): coinB only
 *        - active bin: both, mid-priced
 *
 * Trigger rules (lite version of cdpm_web worker §5.5):
 *   - Active bin not in position range → full recenter.
 *   - Active bin drifts ≥ DRIFT_BINS from distribution center → recenter.
 *   - Within range + fees in fee bag → emit collect-and-reinvest plan (drains
 *     and re-adds to the same target bins, including fee balance).
 *   - Otherwise → null (no action).
 */

import type { Strategy, StrategyInput, StrategyOutput } from "./types.ts";
import {
  computeBinWeights,
  pickBinRange,
} from "../forecast/binWeights.ts";
import {
  ewmaSigma,
  parkinsonSigma,
  scaleSigmaToHorizon,
} from "../forecast/garch.ts";
import type { OhlcvBar, PriceDistribution } from "../forecast/types.ts";
import { priceFromBinId } from "../domain/binMath.ts";
import { log } from "../lib/logger.ts";

export interface MultiBinSpotParams {
  /** Half-width multiplier on σ_horizon. Default 3 covers ~99.7 % of mass. */
  sigmaMultiplier?: number;
  /** Forecast horizon for σ scaling. Default 30 minutes. */
  horizonMs?: number;
  /** Distance from distribution center (in bins) that triggers a recenter. */
  driftBinsTrigger?: number;
  /** Hard cap on half-width in bins (per `pickBinRange`). */
  maxHalfWidthBins?: number;
}

const DEFAULT_PARAMS: Required<MultiBinSpotParams> = {
  sigmaMultiplier: 3,
  horizonMs: 30 * 60 * 1000,
  driftBinsTrigger: 3,
  maxHalfWidthBins: 16,
};

/** Splits totalRaw into n integer parts proportional to weights[i]. */
function splitProportional(totalRaw: bigint, weights: number[]): bigint[] {
  if (weights.length === 0) return [];
  if (totalRaw === 0n) return weights.map(() => 0n);

  // Scale weights to integer permille for stable bigint math.
  const sum = weights.reduce((s, w) => s + w, 0);
  if (sum <= 0) {
    // Even split fallback.
    const per = totalRaw / BigInt(weights.length);
    const out = weights.map(() => per);
    out[out.length - 1] = totalRaw - per * BigInt(weights.length - 1);
    return out;
  }
  const scale = 1_000_000_000n; // 9-digit precision
  const scaled = weights.map((w) => BigInt(Math.floor((w / sum) * Number(scale))));
  const scaledSum = scaled.reduce((s, v) => s + v, 0n);

  const parts: bigint[] = scaled.map((s) => (totalRaw * s) / scaledSum);
  // Distribute rounding dust onto the last non-zero-weight bin.
  let allocated = parts.reduce((s, v) => s + v, 0n);
  let i = parts.length - 1;
  while (allocated < totalRaw && i >= 0) {
    const w = weights[i];
    if (w !== undefined && w > 0) {
      const dust = totalRaw - allocated;
      parts[i] = (parts[i] ?? 0n) + dust;
      allocated += dust;
      break;
    }
    i--;
  }
  return parts;
}

function buildDistribution(
  spotPrice: number,
  ohlcvBars: OhlcvBar[],
  history: { timestampMs: number; price: number }[],
  params: Required<MultiBinSpotParams>,
  barPeriodMs: number,
): PriceDistribution {
  // Prefer Parkinson when we have OHLC bars (~5× more efficient).
  let sigmaPerBar: number;
  let estimator: string;
  if (ohlcvBars.length >= 5) {
    sigmaPerBar = parkinsonSigma(ohlcvBars);
    estimator = "parkinson";
  } else if (history.length >= 2) {
    // Fall back to close-to-close EWMA on raw prices, treating the sequence's
    // average spacing as the "per-bar" period.
    sigmaPerBar = ewmaSigma(history.map((h) => h.price));
    estimator = "ewma";
  } else {
    // Cold-start: no history. Use a conservative default σ that gives a
    // reasonable bin spread until real data arrives.
    sigmaPerBar = 0.001; // 10 bp per bar
    estimator = "cold-start";
  }

  const sigmaHorizon = scaleSigmaToHorizon(sigmaPerBar, barPeriodMs, params.horizonMs);

  return {
    logMu: Math.log(spotPrice),
    sigma: sigmaHorizon,
    horizonMs: params.horizonMs,
    estimator,
  };
}

export function createMultiBinSpotStrategy(params: MultiBinSpotParams = {}): Strategy {
  const p: Required<MultiBinSpotParams> = { ...DEFAULT_PARAMS, ...params };

  return {
    name: "multiBinSpot",

    plan(input: StrategyInput): StrategyOutput {
      const { pm, pool, spot, history, profile } = input;

      // Nothing to do when there is no capital and no position.
      const hasBalance = pm.balance.a > 0n || pm.balance.b > 0n;
      const hasPosition = pm.positionBins.length > 0;
      const hasFees = pm.feeBag.a > 0n || pm.feeBag.b > 0n;
      if (!hasBalance && !hasPosition && !hasFees) {
        return { kind: "quiet", reason: "multiBinSpot: empty PM" };
      }

      const spotPrice = Number(spot.price);
      if (!Number.isFinite(spotPrice) || spotPrice <= 0) {
        log.warn("multiBinSpot: invalid spot price, skipping", { spotPrice });
        return { kind: "quiet", reason: `multiBinSpot: invalid spot price ${spot.price}` };
      }

      // Average bar period: time span / count, fallback to 60s.
      let barPeriodMs = 60_000;
      if (history.length >= 2) {
        const first = history[0]?.timestampMs ?? 0;
        const last = history[history.length - 1]?.timestampMs ?? 0;
        const span = last - first;
        if (span > 0) {
          barPeriodMs = Math.max(span / (history.length - 1), 1_000);
        }
      }

      const dist = buildDistribution(
        spotPrice,
        [], // OHLC bars are read by the rebalancer if needed; v0 uses raw history.
        history.map((h) => ({ timestampMs: h.timestampMs, price: Number(h.price) })),
        p,
        barPeriodMs,
      );

      // Bin range derived from σ_horizon translated to bins via binStep:
      //   1 bin ≈ binStep bps. σ in log units ≈ σ × 10_000 bps.
      //   halfWidth (bins) ≈ multiplier × σ × 10_000 / binStep.
      const halfBinsRaw = (p.sigmaMultiplier * dist.sigma * 10_000) / profile.binStep;
      const range = pickBinRange(pool.activeBinId, halfBinsRaw, p.maxHalfWidthBins);

      const weights = computeBinWeights({
        bins: range.bins,
        binStep: profile.binStep,
        decimalsA: profile.decimalsA,
        decimalsB: profile.decimalsB,
        activeBinId: pool.activeBinId,
        feeRateBps: pool.feeRateBps,
        distribution: dist,
      });

      // ---- Trigger evaluation ----
      const lowestPositionBin = hasPosition
        ? pm.positionBins.reduce((m, b) => (b.binId < m ? b.binId : m), pm.positionBins[0]!.binId)
        : null;
      const highestPositionBin = hasPosition
        ? pm.positionBins.reduce((m, b) => (b.binId > m ? b.binId : m), pm.positionBins[0]!.binId)
        : null;

      const outOfRange =
        hasPosition &&
        (pool.activeBinId < (lowestPositionBin ?? pool.activeBinId) ||
          pool.activeBinId > (highestPositionBin ?? pool.activeBinId));

      const drift = hasPosition && lowestPositionBin !== null && highestPositionBin !== null
        ? Math.abs(pool.activeBinId - Math.round((lowestPositionBin + highestPositionBin) / 2))
        : 0;

      const driftTriggered = hasPosition && drift >= p.driftBinsTrigger;

      const shouldRecenter = !hasPosition || outOfRange || driftTriggered;

      if (!shouldRecenter && !hasFees) {
        return { kind: "quiet", reason: "multiBinSpot: in range, no fees" };
      }

      // ---- Build the plan ----
      // Remove everything currently open (we redeploy from scratch).
      const removeShares = new Map<number, bigint>();
      if (hasPosition) {
        for (const bin of pm.positionBins) {
          if (bin.liquidityShare > 0n) removeShares.set(bin.binId, bin.liquidityShare);
        }
      }

      // Split balance + fees across bins by side.
      // bid side bins (id < active) absorb coinA; ask side bins absorb coinB;
      // the active bin gets a half of each at its mid-price.
      const grossA = pm.balance.a + (hasFees ? pm.feeBag.a : 0n);
      const grossB = pm.balance.b + (hasFees ? pm.feeBag.b : 0n);
      const totalA = grossA;
      const totalB = grossB;

      const bidIdx: number[] = [];
      const askIdx: number[] = [];
      const activeIdx: number[] = [];
      weights.bins.forEach((b, i) => {
        if (b.binId < pool.activeBinId) bidIdx.push(i);
        else if (b.binId > pool.activeBinId) askIdx.push(i);
        else activeIdx.push(i);
      });

      // Reserve a small chunk for the active bin (5 % of each side) so it
      // isn't a hard 0-weight when σ is small; the active bin's behavior is
      // captured properly in the post-plan reconcile step (Phase 2 / v2).
      const activeReserveA = totalA / 20n;
      const activeReserveB = totalB / 20n;
      const aForBids = totalA - activeReserveA;
      const bForAsks = totalB - activeReserveB;

      const bidWeights = bidIdx.map((i) => weights.bins[i]!.weight);
      const askWeights = askIdx.map((i) => weights.bins[i]!.weight);

      const bidAmounts = splitProportional(aForBids, bidWeights);
      const askAmounts = splitProportional(bForAsks, askWeights);

      const addAmountsA: bigint[] = weights.bins.map(() => 0n);
      const addAmountsB: bigint[] = weights.bins.map(() => 0n);

      bidIdx.forEach((i, j) => {
        addAmountsA[i] = bidAmounts[j] ?? 0n;
      });
      askIdx.forEach((i, j) => {
        addAmountsB[i] = askAmounts[j] ?? 0n;
      });
      if (activeIdx.length === 1 && activeIdx[0] !== undefined) {
        addAmountsA[activeIdx[0]] = activeReserveA;
        addAmountsB[activeIdx[0]] = activeReserveB;
      } else {
        // No active bin in range (shouldn't happen with pickBinRange) — fold
        // the reserves back into the side with the most mass.
        if (bidIdx.length > 0 && bidIdx[0] !== undefined) {
          addAmountsA[bidIdx[0]] = (addAmountsA[bidIdx[0]] ?? 0n) + activeReserveA;
        }
        if (askIdx.length > 0 && askIdx[0] !== undefined) {
          addAmountsB[askIdx[0]] = (addAmountsB[askIdx[0]] ?? 0n) + activeReserveB;
        }
      }

      // Drop bins with zero on both sides — saves gas and avoids zero-share moves.
      const finalBins: number[] = [];
      const finalA: bigint[] = [];
      const finalB: bigint[] = [];
      weights.bins.forEach((b, i) => {
        const a = addAmountsA[i] ?? 0n;
        const bAmt = addAmountsB[i] ?? 0n;
        if (a === 0n && bAmt === 0n) return;
        finalBins.push(b.binId);
        finalA.push(a);
        finalB.push(bAmt);
      });

      const reason = `multiBinSpot: ${shouldRecenter ? (outOfRange ? "out-of-range" : driftTriggered ? "drift" : "init") : "fees-only"} σ=${dist.sigma.toFixed(5)} bins=${finalBins.length} center=${pool.activeBinId} priceMid=${priceFromBinId(pool.activeBinId, profile.binStep, profile.decimalsA, profile.decimalsB)}`;

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
        },
      };
    },
  };
}
