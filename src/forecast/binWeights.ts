/**
 * Map a `PriceDistribution` to a per-bin weight vector. Each bin gets a weight
 * equal to its share of the log-normal density mass between its lower and
 * upper price boundaries, with a dead-zone derate around the active bin to
 * reflect the pool's fee friction (per `docs/forecasting-approach.md`).
 *
 * For a DLMM with binStep ε (in bp), bin i's boundaries straddle its mid-price:
 *   priceMid_i = priceFromBinId(i)
 *   The bin extends from priceMid_i × (1 - ε/2/10_000) to priceMid_i × (1 + ε/2/10_000).
 * For simplicity and parity with the SDK we use the boundaries
 *   [priceFromBinId(i)·(1 - ε), priceFromBinId(i)·(1 + ε)] / 2 effectively —
 * but the practical choice is the bin's neighbour mid-points. We pick
 * boundaries at the midpoint between adjacent bins, which is what the protocol
 * fills against.
 */

import { priceFromBinId } from "../domain/binMath.ts";
import type { BinWeight, PriceDistribution } from "./types.ts";

export interface BinWeightInput {
  /** Bin ids in ascending order. */
  bins: number[];
  binStep: number;
  decimalsA: number;
  decimalsB: number;
  activeBinId: number;
  /** Pool fee in basis points; used to compute the dead-zone width. */
  feeRateBps: number;
  distribution: PriceDistribution;
}

export interface BinWeightResult {
  bins: BinWeight[];
  /** Sum of raw (pre-normalization) probabilities — used as a goodness-of-fit. */
  rawMass: number;
}

/**
 * Standard normal CDF via Abramowitz & Stegun 7.1.26 (max error ~7.5e-8).
 * Adequate precision for portfolio weighting; avoids pulling in a dep.
 */
export function normCdf(x: number): number {
  // erf via A&S 7.1.26
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * ax);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const erfApprox =
    1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  const erf = sign * erfApprox;
  return 0.5 * (1 + erf);
}

/** Inclusive probability that log-return lies in [logL, logH]. */
function massInLogRange(logL: number, logH: number, mu: number, sigma: number): number {
  if (sigma <= 0) return logL <= mu && mu < logH ? 1 : 0;
  const lo = (logL - mu) / sigma;
  const hi = (logH - mu) / sigma;
  const p = normCdf(hi) - normCdf(lo);
  return p > 0 ? p : 0;
}

/**
 * Mid-price between bin i and bin i+1 is geometrically halfway:
 *   midPrice(i, i+1) = sqrt(P_i × P_{i+1})
 * because bin prices are geometric (each step ~ (1 + ε)).
 */
function midPriceLog(
  binId: number,
  step: number,
  binStep: number,
  decimalsA: number,
  decimalsB: number,
): number {
  const p1 = Number(priceFromBinId(binId, binStep, decimalsA, decimalsB));
  const p2 = Number(priceFromBinId(binId + step, binStep, decimalsA, decimalsB));
  // geometric mid → ln midpoint = (ln p1 + ln p2) / 2.
  return 0.5 * (Math.log(p1) + Math.log(p2));
}

/**
 * Apply the pool fee as a dead-zone derate around the active bin.
 *
 * An LP order at price P_bin only fills when the taker market crosses through
 * P_bin × (1 + fee) — within ±fee of active, the market must travel further
 * than the bin width to fill. We scale down those bins linearly with their
 * distance from active, going from 0 at the active bin's center to 1 at the
 * first bin fully outside the fee dead-zone.
 *
 * Conservative for v0: a more accurate model would account for the path
 * dependence (a brief touch fills the order). v1 can swap this for a
 * reflected-barrier or simulation-based fill probability.
 */
function feeDerate(
  binId: number,
  activeBinId: number,
  binStepBps: number,
  feeRateBps: number,
): number {
  if (feeRateBps <= 0) return 1;
  const distBins = Math.abs(binId - activeBinId);
  // How many bins fit inside the fee dead-zone (one-sided).
  const deadZoneBins = feeRateBps / binStepBps;
  if (distBins >= deadZoneBins) return 1;
  // Linear ramp from 0 (at active) to 1 (at the edge of the dead zone).
  return distBins / Math.max(deadZoneBins, 1);
}

export function computeBinWeights(input: BinWeightInput): BinWeightResult {
  const { bins, binStep, decimalsA, decimalsB, activeBinId, feeRateBps, distribution } =
    input;
  const { logMu, sigma } = distribution;

  if (bins.length === 0) return { bins: [], rawMass: 0 };

  // Compute raw probabilities first, then renormalize after derate.
  const raw: { binId: number; mass: number; priceMid: string }[] = [];
  for (const binId of bins) {
    // Bin boundaries: midpoint to lower neighbour and midpoint to upper neighbour.
    const lowerLog = midPriceLog(binId, -1, binStep, decimalsA, decimalsB);
    const upperLog = midPriceLog(binId, +1, binStep, decimalsA, decimalsB);

    const rawMass = massInLogRange(lowerLog, upperLog, logMu, sigma);
    const derate = feeDerate(binId, activeBinId, binStep, feeRateBps);
    const mass = rawMass * derate;

    raw.push({
      binId,
      mass,
      priceMid: priceFromBinId(binId, binStep, decimalsA, decimalsB),
    });
  }

  const rawMass = raw.reduce((s, r) => s + r.mass, 0);
  if (rawMass <= 0) {
    // Degenerate: all bins outside the distribution support. Fall back to a
    // uniform weight over the requested bins so the caller still gets a plan.
    const uniform = 1 / raw.length;
    return {
      bins: raw.map((r) => ({ binId: r.binId, weight: uniform, priceMid: r.priceMid })),
      rawMass: 0,
    };
  }

  const norm = raw.map((r) => ({
    binId: r.binId,
    weight: r.mass / rawMass,
    priceMid: r.priceMid,
  }));

  return { bins: norm, rawMass };
}

/**
 * Pick an inclusive bin range [lower, upper] centered on `activeBinId`,
 * extending out to ±halfWidthBins. Clipped to ±maxHalfWidthBins (default 16,
 * which gives 33 bins total — well under the CDPM 70-bin-per-position cap).
 */
export function pickBinRange(
  activeBinId: number,
  halfWidthBins: number,
  maxHalfWidthBins = 16,
): { lower: number; upper: number; bins: number[] } {
  const half = Math.min(Math.max(Math.round(halfWidthBins), 1), maxHalfWidthBins);
  const lower = activeBinId - half;
  const upper = activeBinId + half;
  const out: number[] = [];
  for (let id = lower; id <= upper; id++) out.push(id);
  return { lower, upper, bins: out };
}
