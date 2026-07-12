/**
 * NullPredictionProvider — deterministic, rule-based prediction provider.
 *
 * This is the W2 "dummy" implementation that wires up the full decision chain
 * before any ML model is available. It is also the permanent last-resort
 * fallback used by `mlAgent` when `SidecarPredictionProvider` is unavailable.
 *
  * Output semantics (center-free since 2026-07 — the distribution is always
 * centered on the active bin; docs/decision-remove-center-prediction.md):
 *   widthSigma                EWMA σ on `snapshot.binance.sui` close prices,
 *                             scaled to the 30-min horizon, then converted to
 *                             bin units (see σ→bin conversion note below).
 *                             Same quantity the sidecar derives from its vol
 *                             head — the two providers are unit-compatible.
 *   pAbove / pBelow           aligned with sidecar definition (F3):
 *                             pAbove = 1 − Φ(upperOffset / widthSigma)
 *                             pBelow = Φ(lowerOffset / widthSigma)
 *                             where offsets are in BIN UNITS relative to activeBin.
 *                             lowerOffset / upperOffset are derived from
 *                             ctx.currentBins (same derivation as sidecarProvider),
 *                             defaulting to ±0.5 bin when currentBins is empty.
 *   modelVersion              "null-v0"
 *   featureCompleteness       1   (fully self-contained, no external features)
 *   psi                       0   (no distribution drift by definition)
 *   fallback                  false (NullProvider never degrades)
 *
 * σ → bin unit conversion
 * ─────────────────────────
 * The DLMM bin grid is geometric: each bin step moves the price by
 *   Δprice/price = binStep / 10_000   (e.g. binStep=10 → 10 bp per bin step)
 *
 * EWMA σ is a log-return σ (i.e. σ ≈ std(ln(P_{t+1}/P_t)) per bar).
 * One bin step corresponds to a log-return of ln(1 + binStep/10_000).
 * For small binStep this is well-approximated by binStep/10_000.
 *
 * Therefore:
 *   σ_bins = σ_log / (binStep / 10_000)
 *          = σ_log × 10_000 / binStep
 *
 * The 30-min horizon is obtained via square-root-of-time from the 1-min bar σ:
 *   σ_horizon = σ_perBar × √(horizonMs / barPeriodMs)
 *             = σ_perBar × √30   (1-min bars → 30-min horizon)
 *
 * pAbove / pBelow (aligned with sidecar — F3)
 * ─────────────────────────────────────────────
 * The sidecar computes (ml/serving/app.py):
 *
 *   pAbove = 1 − Φ(upperOffset / widthSigma)
 *   pBelow = Φ(lowerOffset / widthSigma)
 *
 * where all offsets are in BIN UNITS relative to activeBin, the center is
 * pinned at 0 (spot), and widthSigma is the horizon offset σ in bin units.
 * The sidecar defaults lowerOffset = −0.5, upperOffset = +0.5 when no
 * pmRangeContext is supplied.
 *
 * NullProvider uses the same formula with:
 *   widthSigma = computed EWMA-based value in bin units (above)
 *   lowerOffset / upperOffset derived from ctx.currentBins the same way
 *   sidecarProvider.buildPmRangeContext() does it:
 *     lowerOffset = min(currentBins) − activeBin
 *     upperOffset = max(currentBins) − activeBin
 *   defaulting to ±0.5 when currentBins is empty (matching sidecar default).
 *
 * For a symmetric range the two values are equal and their sum < 1.
 *
 * Both use the Abramowitz & Stegun normCdf already exported from
 * `src/forecast/binWeights.ts`, so no new math dependency is introduced.
 *
 * Pure, deterministic, no I/O — safe in tests and shadow mode.
 */

import { ewmaSigma, scaleSigmaToHorizon } from "../forecast/volatility.ts";
import { normCdf } from "../forecast/binWeights.ts";
import type { PredictionProvider } from "./provider.ts";
import type {
  MarketSnapshot,
  PmRangeContext,
  PredictionResponse,
  ProviderHealth,
} from "./types.ts";

/** Horizon used for σ scaling (30 minutes). */
const HORIZON_MS = 30 * 60 * 1000;

/** Bar period assumption when `binance.sui` bars are 1-minute bars. */
const BAR_PERIOD_MS = 60 * 1000;

/** Default offset (in bin units) used when no pmRangeContext is available. Matches sidecar default. */
const DEFAULT_HALF_OFFSET = 0.5;

/**
 * Compute widthSigma in bin units from the EWMA σ on binance.sui bar closes.
 *
 * Steps:
 *   1. Extract close prices from snapshot.binance.sui (oldest-first).
 *   2. EWMA σ per 1-min bar (log-return units).
 *   3. Scale to 30-min horizon: σ_horizon = σ_bar × √30.
 *   4. Convert to bin units: σ_bins = σ_horizon × 10_000 / binStep.
 *
 * Returns a minimum of 0.5 bins so downstream callers always have a
 * non-zero width even on flat price histories.
 */
function computeWidthSigmaBins(snapshot: MarketSnapshot, binStep: number): number {
  const closes = snapshot.binance.sui.map((bar) => bar.close).filter((c) => c > 0);
  const sigmaPerBar = ewmaSigma(closes);
  const sigmaHorizon = scaleSigmaToHorizon(sigmaPerBar, BAR_PERIOD_MS, HORIZON_MS);
  const sigmaBins = (sigmaHorizon * 10_000) / binStep;
  return Math.max(sigmaBins, 0.5);
}

/**
 * Compute pAbove and pBelow using the sidecar-aligned definition (F3).
 *
 * Formula (mirrors ml/serving/app.py; center pinned at 0):
 *   pAbove = 1 − Φ(upperOffset / widthSigma)
 *   pBelow = Φ(lowerOffset / widthSigma)
 *
 * All values are in BIN UNITS relative to activeBin.
 *
 * When currentBins is empty, the offsets default to ±0.5 bin (sidecar default).
 * When currentBins is non-empty, lowerOffset and upperOffset are derived the
 * same way sidecarProvider.buildPmRangeContext() computes them:
 *   lowerOffset = min(currentBins) − activeBin
 *   upperOffset = max(currentBins) − activeBin
 *
 * @param widthSigma  - prediction width in bin units
 * @param ctx         - PM range context (used to derive lowerOffset/upperOffset)
 */
function computePAbovePBelow(
  widthSigma: number,
  ctx: PmRangeContext,
): { pAbove: number; pBelow: number } {
  // Derive offsets in bin units relative to activeBin.
  let lowerOffset: number;
  let upperOffset: number;
  if (ctx.currentBins.length > 0) {
    lowerOffset = Math.min(...ctx.currentBins) - ctx.activeBin;
    upperOffset = Math.max(...ctx.currentBins) - ctx.activeBin;
  } else {
    lowerOffset = -DEFAULT_HALF_OFFSET;
    upperOffset = DEFAULT_HALF_OFFSET;
  }

  // Center is pinned at 0 — no directional prediction (by design, see
  // docs/decision-remove-center-prediction.md).
  const w = Math.max(widthSigma, 1e-9);

  // pAbove = 1 − Φ(upperOffset / widthSigma)
  const pAbove = 1 - normCdf(upperOffset / w);
  // pBelow = Φ(lowerOffset / widthSigma)
  const pBelow = normCdf(lowerOffset / w);

  return { pAbove, pBelow };
}

export class NullPredictionProvider implements PredictionProvider {
  readonly name = "null";

  async predict(snapshot: MarketSnapshot, ctx: PmRangeContext): Promise<PredictionResponse> {
    const binStep = ctx.binStep > 0 ? ctx.binStep : snapshot.cetus.binStep;

    // 1. Compute widthSigma in bin units.
    const widthSigma = computeWidthSigmaBins(snapshot, binStep);

    // 2. pAbove / pBelow using the sidecar-aligned formula (F3).
    const { pAbove, pBelow } = computePAbovePBelow(widthSigma, ctx);

    return {
      widthSigma,
      pAbove,
      pBelow,
      modelVersion: "null-v0",
      featureCompleteness: 1,
      psi: 0,
      fallback: false,
    };
  }

  async health(): Promise<ProviderHealth> {
    return {
      ok: true,
      modelVersion: "null-v0",
      detail: "NullPredictionProvider is always healthy",
    };
  }
}

/**
 * Factory function following the project's named-factory convention.
 * Prefer this over `new NullPredictionProvider()` at call sites.
 */
export function createNullPredictionProvider(): NullPredictionProvider {
  return new NullPredictionProvider();
}
