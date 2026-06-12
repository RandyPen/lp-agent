/**
 * NullPredictionProvider — deterministic, rule-based prediction provider.
 *
 * This is the W2 "dummy" implementation that wires up the full decision chain
 * before any ML model is available. It is also the permanent last-resort
 * fallback used by `mlAgent` when `SidecarPredictionProvider` is unavailable.
 *
 * Output semantics:
 *   centerOffset = 0          (no directional prediction; stay at active bin)
 *   centerQ10/Q90             symmetric: active ± ceil(widthSigma × 1.28)
 *                             (±1.28 σ ≈ the 80 % equal-tailed interval)
 *   widthSigma                EWMA σ on `snapshot.binance.sui` close prices,
 *                             scaled to the 30-min horizon, then converted to
 *                             bin units (see σ→bin conversion note below)
 *   pAbove / pBelow           log-normal closed-form via normal CDF
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
 * pAbove / pBelow
 * ───────────────
 * Under a log-normal model with log-return μ=0 (we predict no drift) and
 * σ_log (per-horizon log σ), the probability that the price at the horizon
 * is above bin i+1's lower boundary (i.e. it "crossed" the active bin upward)
 * is:
 *   pAbove = 1 − Φ((ln(P_upper / P_current)) / σ_log)
 *
 * where P_upper is the price at the upper boundary of the active bin
 * (approximately P_current × (1 + binStep/10_000)).
 *
 * Symmetrically:
 *   pBelow = Φ((ln(P_lower / P_current)) / σ_log)
 *          = Φ(−ln(1 + binStep/10_000) / σ_log)
 *          ≈ Φ(−binStep / (10_000 × σ_log))
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
 * Compute pAbove and pBelow using the log-normal closed-form.
 *
 * pAbove = P(price moves up by more than 1 bin step within horizon)
 *        = 1 − Φ(ln(1 + binStep/10_000) / σ_horizon)
 * pBelow = P(price moves down by more than 1 bin step within horizon)
 *        = Φ(ln(1 / (1 + binStep/10_000)) / σ_horizon)
 *        = Φ(−ln(1 + binStep/10_000) / σ_horizon)
 *
 * At the natural midpoint of a symmetric log-normal with μ=0, these two
 * values are equal (both < 0.5). Their sum is always < 1.
 */
function computePAbovePBelow(
  sigmaHorizon: number,
  binStep: number,
): { pAbove: number; pBelow: number } {
  const logBinStep = Math.log(1 + binStep / 10_000);
  const z = logBinStep / Math.max(sigmaHorizon, 1e-9);
  const pAbove = 1 - normCdf(z);   // probability of price crossing active bin upward
  const pBelow = normCdf(-z);      // probability of price crossing active bin downward
  return { pAbove, pBelow };
}

export class NullPredictionProvider implements PredictionProvider {
  readonly name = "null";

  async predict(snapshot: MarketSnapshot, ctx: PmRangeContext): Promise<PredictionResponse> {
    const binStep = ctx.binStep > 0 ? ctx.binStep : snapshot.cetus.binStep;

    // 1. Compute widthSigma in bin units.
    const widthSigma = computeWidthSigmaBins(snapshot, binStep);

    // 2. Compute σ_horizon in log-return units for pAbove/pBelow.
    const closes = snapshot.binance.sui.map((bar) => bar.close).filter((c) => c > 0);
    const sigmaPerBar = ewmaSigma(closes);
    const sigmaHorizon = scaleSigmaToHorizon(sigmaPerBar, BAR_PERIOD_MS, HORIZON_MS);

    // 3. Symmetric quantiles: ±1.28 σ in bin units covers ~80 % of the
    //    log-normal mass (Φ(1.28) ≈ 0.90, so Φ(1.28) − Φ(−1.28) ≈ 0.80).
    const halfInterval = Math.ceil(widthSigma * 1.28);
    const centerQ10 = -halfInterval;
    const centerQ90 = +halfInterval;

    // 4. pAbove / pBelow via log-normal CDF.
    const { pAbove, pBelow } = computePAbovePBelow(sigmaHorizon, binStep);

    return {
      centerOffset: 0,
      centerQ10,
      centerQ90,
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
