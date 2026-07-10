/**
 * presenceAnchor strategy — anchor-reversion market-making with
 * presence-only defense ("presence architecture").
 *
 * Empirical grounding (operator study on 12 months of SUIUSDC 1m data,
 * 2025-07 → 2026-07; see the operator-local analysis notes):
 *   - SUI/USDC mean-reverts at 30min–1d scales (VR(60m)=0.64, Hurst≈0.43);
 *     the reversion anchor is a slow rolling mean, OU half-life ≈ 1h vs a
 *     4h anchor. Momentum direction does NOT persist (sign-autocorr ≈ 0.01).
 *   - Volatility clusters strongly (60m realized-vol autocorr ≈ 0.74; vol
 *     regimes are ~70% sticky over the next hour) → a vol-regime NOWCAST is
 *     predictive; a direction forecast is not.
 *   - In a 0.4%-fee pool, maker-based inventory conversion is unreliable
 *     exactly when needed (a tight ask fills before the drop only ~32% of
 *     down-windows once the fee-crossing is priced in), and the agent has no
 *     taker permission at all — so the ONLY defense action this strategy
 *     ever takes is PRESENCE control: withdraw liquidity (free, atomic,
 *     permission-native). It never tries to convert inventory defensively.
 *
 * Per-tick pipeline (pure function of StrategyInput — no DB, no clock):
 *   1. Bucket `history` (a 4h window, see `historyWindowMs`) into 1m bars.
 *   2. Vol-regime nowcast: σ_short(60m) / σ_long(4h) ratio →
 *      NORMAL / TREND / DEFENSE, with a re-entry hysteresis (the recent
 *      `reentryCalmMs` must be free of DEFENSE-level ratios before
 *      liquidity is redeployed after a spike).
 *   3. DEFENSE → full withdrawal (reuses buildExtremeWithdrawPlan), idle
 *      swept to lending via stateCtx.lendingPct = 1. No conversion attempt.
 *   4. NORMAL → center pulled from the active bin toward the 4h anchor
 *      (clamped), gaussian/log-normal mass split around it; TREND → center
 *      on active, halfWidth widened, only half the capital deployed.
 *   5. Inventory steering vs `targetBaseShare` (default 0.35, quote-heavy):
 *      the side whose fills would WORSEN the inventory error deploys less
 *      (×0.5) or nothing; the excess stays idle and is swept to lending.
 *      Composition thus only ever changes through fee-EARNING fills placed
 *      during normal quoting — never through defensive conversion.
 *
 * Cold start (documented, deliberate): with less than `minHistoryMs` of
 * history the anchor and the regime nowcast are not computable — the
 * strategy centers on the active bin with a conservative default σ and
 * reversion off, exactly like multiBinSpot's cold-start convention.
 */

import type { Strategy, StrategyInput, StrategyOutput } from "./types.ts";
import type { PMState, RebalancePlan } from "../domain/types.ts";
import type { MarketState, StateContext } from "../prediction/types.ts";
import { computeBinWeights, pickBinRange } from "../forecast/binWeights.ts";
import { bucketToOhlcv, ewmaSigma, scaleSigmaToHorizon, MIN_SIGMA } from "../forecast/volatility.ts";
import { buildExtremeWithdrawPlan } from "../decision/diffPlanner.ts";
import { EVAL_INTERVAL_MS, MIN_DWELL_MS } from "../state/params.ts";
import { binDirection, humanPriceForBin, orientationOf } from "../domain/binMath.ts";
import { log } from "../lib/logger.ts";

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

export interface PresenceAnchorParams {
  /** Window for the reversion anchor (rolling mean of log price). */
  anchorWindowMs?: number;
  /** Width-scaling horizon. 60–120min is the measured MM sweet spot. */
  horizonMs?: number;
  /** Short window for the regime nowcast σ. */
  volShortWindowMs?: number;
  /** σ_short/σ_long ratio at which TREND de-risking starts. */
  trendVolRatio?: number;
  /** σ_short/σ_long ratio at which DEFENSE (full withdrawal) triggers. */
  defenseVolRatio?: number;
  /**
   * Drift-strength z at which DEFENSE triggers: |net move over the anchor
   * window| / (σ_bar × √bars). The vol-ratio gate alone is blind to
   * low-volatility grinding trends (NAV-replay evidence: adding this gate
   * was worth +7.5pp vs HODL in the bear year and +66pp absolute in the
   * bull year). Same 2.0 entry as the mlAgent state machine's
   * driftStrengthEntry; exit hysteresis is time-based via `reentryCalmMs`
   * (this strategy is stateless — no latch to persist).
   */
  driftEnterZ?: number;
  /**
   * Re-entry hysteresis: after a DEFENSE-level spike, the trailing window of
   * this length must be free of DEFENSE-level ratios before redeploying.
   */
  reentryCalmMs?: number;
  /** Inventory target: base share of deployable value (quote-heavy < 0.5). */
  targetBaseShare?: number;
  /** Fraction of the anchor deviation pulled into the center offset. */
  reversionGain?: number;
  /** Hard cap on the center offset (bins from active). */
  maxCenterOffsetBins?: number;
  /** halfWidth = clamp(round(kW × σ_bins), min, max). */
  kW?: number;
  minHalfWidthBins?: number;
  maxHalfWidthBins?: number;
  /** TREND: halfWidth multiplier and capital deployment fraction. */
  trendWidenFactor?: number;
  trendCapitalScale?: number;
  /** Inventory bands: |err| below `invBandSoft` → no steering. */
  invBandSoft?: number;
  invBandHard?: number;
  /** Below this much history the strategy runs the documented cold-start. */
  minHistoryMs?: number;
  /** Lending targets handed to the router via stateCtx. */
  lendingPctNormal?: number;
  lendingPctTrend?: number;
}

/**
 * Defaults. Vol-ratio thresholds are heuristic pre-calibration values (the
 * year study established stickiness of vol terciles, not these exact ratios)
 * — they are the first knobs a W5-style grid search should freeze.
 *
 * Structural cap on the ratio: σ_long is computed over the FULL window
 * (short window included), so a fresh burst concentrated entirely inside the
 * short window tops out at √(anchorWindow / volShortWindow) = √(4h/1h) = 2.0.
 * Both thresholds must sit below that cap. A sustained storm older than the
 * anchor window decays the ratio back toward 1 — deliberately: stationary
 * high vol is handled by σ-scaled WIDTH, DEFENSE is for vol TRANSITIONS
 * (the empirically dangerous part).
 */
export const PRESENCE_DEFAULTS: Required<PresenceAnchorParams> = {
  anchorWindowMs: 4 * 60 * 60 * 1000,
  horizonMs: 90 * 60 * 1000,
  volShortWindowMs: 60 * 60 * 1000,
  trendVolRatio: 1.3,
  defenseVolRatio: 1.7,
  driftEnterZ: 2.0,
  reentryCalmMs: 30 * 60 * 1000,
  targetBaseShare: 0.35,
  reversionGain: 0.5,
  maxCenterOffsetBins: 3,
  kW: 2.0,
  minHalfWidthBins: 2,
  maxHalfWidthBins: 8,
  trendWidenFactor: 1.5,
  trendCapitalScale: 0.5,
  invBandSoft: 0.10,
  invBandHard: 0.25,
  minHistoryMs: 60 * 60 * 1000,
  lendingPctNormal: 0.35,
  lendingPctTrend: 0.6,
};

/** Presence regime. DEFENSE maps onto the shared EXTREME semantics. */
export type PresenceRegime = "NORMAL" | "TREND" | "DEFENSE";

// ---------------------------------------------------------------------------
// Small helpers (pure)
// ---------------------------------------------------------------------------

/** Scale a bigint by a fraction in [0, 1+] via 6-digit fixed point. */
export function mulFrac(x: bigint, frac: number): bigint {
  if (frac >= 1) return x;
  if (frac <= 0) return 0n;
  const SCALE = 1_000_000n;
  return (x * BigInt(Math.round(frac * 1_000_000))) / SCALE;
}

/** Realized σ per bar: sqrt(mean r²) over consecutive log-price returns. */
export function realizedSigma(closes: number[]): number {
  if (closes.length < 2) return MIN_SIGMA;
  let sum = 0;
  let n = 0;
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1]!;
    const b = closes[i]!;
    if (a <= 0 || b <= 0) continue;
    const r = Math.log(b / a);
    sum += r * r;
    n++;
  }
  if (n === 0) return MIN_SIGMA;
  return Math.max(Math.sqrt(sum / n), MIN_SIGMA);
}

/** splitProportional: same convention as multiBinSpot (dust → last non-zero). */
export function splitProportional(totalRaw: bigint, weights: number[]): bigint[] {
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
  const parts = scaled.map((s) => (totalRaw * s) / scaledSum);
  let allocated = parts.reduce((s, v) => s + v, 0n);
  let i = parts.length - 1;
  while (allocated < totalRaw && i >= 0) {
    const w = weights[i];
    if (w !== undefined && w > 0) {
      parts[i] = (parts[i] ?? 0n) + (totalRaw - allocated);
      break;
    }
    i--;
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Regime nowcast
// ---------------------------------------------------------------------------

export interface RegimeReadout {
  regime: PresenceRegime;
  /** Current σ_short/σ_long ratio (NaN in cold start). */
  volRatio: number;
  /** Current drift-strength z over the anchor window (NaN when history is short). */
  driftZ: number;
  /** True when the trailing calm window still contains a DEFENSE-level signal. */
  reentryBlocked: boolean;
}

/**
 * Drift-strength z at time `tMs`: |net log move over the trailing anchor
 * window| / (per-bar σ of that window × √bars). The state machine's
 * driftStrength analog, computable purely from the bar series. NaN when the
 * lookback does not reach a full anchor window (cold start / early bars —
 * an unjudgeable point is simply not a trigger).
 */
export function driftZAt(
  bars: { bucketStartMs: number; close: number }[],
  tMs: number,
  p: Required<PresenceAnchorParams>,
): number {
  const win = bars.filter(
    (b) => b.bucketStartMs > tMs - p.anchorWindowMs && b.bucketStartMs <= tMs,
  );
  const past = bars.filter((b) => b.bucketStartMs <= tMs - p.anchorWindowMs);
  if (win.length < 30 || past.length === 0) return Number.NaN;
  const cur = win[win.length - 1]!.close;
  const ref = past[past.length - 1]!.close;
  if (cur <= 0 || ref <= 0) return Number.NaN;
  const sigma = realizedSigma(win.map((b) => b.close));
  return Math.abs(Math.log(cur / ref)) / (sigma * Math.sqrt(win.length));
}

/**
 * Nowcast the regime from 1m bars: vol-ratio transitions AND drift strength
 * (grinding trends the vol gate cannot see). Stateless across ticks: the
 * re-entry hysteresis is derived from the history series itself (rolling
 * readings across the trailing calm window), so a process restart cannot
 * skip the cooldown — everything is recomputed from data.
 */
export function nowcastRegime(
  bars: { bucketStartMs: number; close: number }[],
  nowMs: number,
  p: Required<PresenceAnchorParams>,
): RegimeReadout {
  // σ_long over the ANCHOR window only (the fetch window is longer —
  // anchorWindow + reentryCalm — so the re-entry scan has full lookback).
  const anchorCloses = bars
    .filter((b) => b.bucketStartMs > nowMs - p.anchorWindowMs)
    .map((b) => b.close);
  const sigmaLong = realizedSigma(anchorCloses);

  const shortCloses = bars
    .filter((b) => b.bucketStartMs > nowMs - p.volShortWindowMs)
    .map((b) => b.close);
  const sigmaShort = realizedSigma(shortCloses);
  const volRatio = sigmaLong > 0 ? sigmaShort / sigmaLong : Number.NaN;

  const driftZ = driftZAt(bars, nowMs, p);

  // Rolling readings at each bar of the trailing calm window: if any point
  // hit a DEFENSE-level signal (vol ratio OR drift), redeployment stays
  // blocked (time-based hysteresis).
  let reentryBlocked = false;
  for (const bar of bars) {
    const t = bar.bucketStartMs;
    if (t <= nowMs - p.reentryCalmMs) continue;
    const win = bars
      .filter((b) => b.bucketStartMs > t - p.volShortWindowMs && b.bucketStartMs <= t)
      .map((b) => b.close);
    if (win.length >= 10 && realizedSigma(win) / sigmaLong >= p.defenseVolRatio) {
      reentryBlocked = true;
      break;
    }
    const dz = driftZAt(bars, t, p);
    if (Number.isFinite(dz) && dz >= p.driftEnterZ) {
      reentryBlocked = true;
      break;
    }
  }

  let regime: PresenceRegime;
  if (
    volRatio >= p.defenseVolRatio ||
    (Number.isFinite(driftZ) && driftZ >= p.driftEnterZ) ||
    reentryBlocked
  ) {
    regime = "DEFENSE";
  } else if (volRatio >= p.trendVolRatio) regime = "TREND";
  else regime = "NORMAL";

  return { regime, volRatio, driftZ, reentryBlocked };
}

// ---------------------------------------------------------------------------
// Inventory steering
// ---------------------------------------------------------------------------

interface InventorySteering {
  /** Deployment fraction for the ask side (holds BASE, fills = sell base). */
  askDeployFrac: number;
  /** Deployment fraction for the bid side (holds QUOTE, fills = buy base). */
  bidDeployFrac: number;
  /** base share of deployable value, for the journal. */
  baseShare: number;
}

/**
 * Presence inventory rule: composition changes only through fee-earning
 * fills, so steering = deploying LESS on the side whose fills would worsen
 * the inventory error. The held-back excess stays idle → lending.
 *
 *   base overweight  → bids buy even more base → reduce/zero the BID side.
 *   base underweight → asks sell scarce base   → reduce/zero the ASK side.
 */
export function steerInventory(
  baseRaw: bigint,
  quoteRaw: bigint,
  baseDecimals: number,
  quoteDecimals: number,
  spotPrice: number,
  p: Required<PresenceAnchorParams>,
): InventorySteering {
  const baseVal = (Number(baseRaw) / 10 ** baseDecimals) * spotPrice;
  const quoteVal = Number(quoteRaw) / 10 ** quoteDecimals;
  const total = baseVal + quoteVal;
  if (!(total > 0) || !Number.isFinite(total)) {
    return { askDeployFrac: 1, bidDeployFrac: 1, baseShare: 0 };
  }
  const baseShare = baseVal / total;
  const err = baseShare - p.targetBaseShare;

  let askDeployFrac = 1;
  let bidDeployFrac = 1;
  if (err >= p.invBandHard) bidDeployFrac = 0;
  else if (err >= p.invBandSoft) bidDeployFrac = 0.5;
  else if (err <= -p.invBandHard) askDeployFrac = 0;
  else if (err <= -p.invBandSoft) askDeployFrac = 0.5;

  return { askDeployFrac, bidDeployFrac, baseShare };
}

// ---------------------------------------------------------------------------
// StateContext for the lending router
// ---------------------------------------------------------------------------

/**
 * The rebalancer's lending router honours `stateCtx.lendingPct` when a
 * strategy provides it. presenceAnchor derives the same context shape the
 * state machine would, from its own regime nowcast. `enteredAtMs` is the
 * snapshot time — this strategy is stateless across ticks by design.
 */
export function buildStateCtx(
  regime: PresenceRegime,
  nowMs: number,
  halfWidth: number,
  toleranceBins: number,
  maxCenterOffset: number,
  p: Required<PresenceAnchorParams>,
): StateContext {
  const state: MarketState = regime === "DEFENSE" ? "EXTREME" : regime;
  const lendingPct =
    regime === "DEFENSE" ? 1.0 : regime === "TREND" ? p.lendingPctTrend : p.lendingPctNormal;
  return {
    state,
    enteredAtMs: nowMs,
    evalIntervalMs: EVAL_INTERVAL_MS[state],
    halfWidth,
    trendBias: 0,
    strongTrend: false,
    lendingPct,
    toleranceBins,
    maxCenterOffset,
    minDwellMs: MIN_DWELL_MS[state],
  };
}

// ---------------------------------------------------------------------------
// Strategy factory
// ---------------------------------------------------------------------------

export function createPresenceAnchorStrategy(params: PresenceAnchorParams = {}): Strategy {
  const p: Required<PresenceAnchorParams> = { ...PRESENCE_DEFAULTS, ...params };

  return {
    name: "presenceAnchor",

    // The rebalancer fetches this much history for us: the anchor window
    // plus the re-entry calm window, so the rolling re-entry scan's drift
    // readings each have a full anchor-window lookback.
    historyWindowMs: p.anchorWindowMs + p.reentryCalmMs,

    async plan(input: StrategyInput): Promise<StrategyOutput> {
      const { pm, pool, spot, history, profile } = input;

      const hasBalance = pm.balance.a > 0n || pm.balance.b > 0n;
      const hasPosition = pm.positionBins.length > 0;
      const hasFees = pm.feeBag.a > 0n || pm.feeBag.b > 0n;
      if (!hasBalance && !hasPosition && !hasFees) {
        return { kind: "quiet", reason: "presenceAnchor: empty PM" };
      }

      const spotPrice = Number(spot.price);
      if (!Number.isFinite(spotPrice) || spotPrice <= 0) {
        log.warn("presenceAnchor: invalid spot price, skipping", { spotPrice: spot.price });
        return { kind: "quiet", reason: `presenceAnchor: invalid spot price ${spot.price}` };
      }

      const orientation = orientationOf(profile);
      const dir = binDirection(orientation);
      const nowMs = spot.timestampMs;

      // ---- 1. Bars + cold-start detection -------------------------------
      const bars = bucketToOhlcv(
        history.map((h) => ({ timestampMs: h.timestampMs, price: Number(h.price) })),
        60_000,
      );
      const spanMs =
        bars.length >= 2 ? bars[bars.length - 1]!.bucketStartMs - bars[0]!.bucketStartMs : 0;
      const coldStart = spanMs < p.minHistoryMs || bars.length < 30;

      // ---- 2. Regime nowcast ---------------------------------------------
      const readout: RegimeReadout = coldStart
        ? { regime: "NORMAL", volRatio: Number.NaN, driftZ: Number.NaN, reentryBlocked: false }
        : nowcastRegime(bars, nowMs, p);

      // ---- 3. σ / width / tolerance --------------------------------------
      // Anchor-window slice: the fetch window is anchorWindow + reentryCalm,
      // but the anchor mean and the width σ are defined over the ANCHOR
      // window only.
      const closes = bars
        .filter((b) => b.bucketStartMs > nowMs - p.anchorWindowMs)
        .map((b) => b.close);
      const sigmaPerBar = coldStart
        ? closes.length >= 2
          ? ewmaSigma(closes)
          : 0.001 // documented cold-start default (10 bp/bar), same as multiBinSpot
        : ewmaSigma(closes);
      const sigmaH = scaleSigmaToHorizon(sigmaPerBar, 60_000, p.horizonMs);
      const logStep = Math.log(1 + profile.binStep / 10_000);
      const sigmaBins = sigmaH / logStep;

      let halfWidth = Math.max(
        p.minHalfWidthBins,
        Math.min(p.maxHalfWidthBins, Math.round(p.kW * sigmaBins)),
      );
      if (readout.regime === "TREND") {
        halfWidth = Math.min(
          Math.round(halfWidth * p.trendWidenFactor),
          p.maxHalfWidthBins + 4,
        );
      }
      const toleranceBins = Math.min(Math.max(1, Math.round(sigmaBins)), halfWidth);

      // ---- 4. DEFENSE: presence-only exit --------------------------------
      if (readout.regime === "DEFENSE") {
        const trig =
          `volRatio=${readout.volRatio.toFixed(2)}` +
          ` driftZ=${Number.isFinite(readout.driftZ) ? readout.driftZ.toFixed(2) : "n/a"}` +
          `${readout.reentryBlocked ? ", re-entry blocked" : ""}`;
        const stateCtx = buildStateCtx("DEFENSE", nowMs, halfWidth, toleranceBins, 0, p);
        const withdraw = buildExtremeWithdrawPlan(
          pm,
          `presenceAnchor: DEFENSE full withdrawal (${trig})`,
        );
        if (!withdraw) {
          // Nothing on the book — keep idle funds swept into lending at 100%.
          return {
            kind: "reconcile_only",
            reason: `presenceAnchor: DEFENSE, nothing to withdraw (${trig})`,
            stateCtx,
          };
        }
        return { kind: "plan_and_reconcile", plan: withdraw, stateCtx };
      }

      // ---- 5. Anchor + reversion-pulled center ---------------------------
      // anchor = exp(mean log close) over the window; dev in HUMAN bin units.
      let centerOffsetHuman = 0;
      let devBins = 0;
      if (!coldStart) {
        const meanLog = closes.reduce((s, c) => s + Math.log(c), 0) / closes.length;
        devBins = (Math.log(spotPrice) - meanLog) / logStep;
        // TREND never chases the anchor (§presence: TREND is pure annealing).
        if (readout.regime === "NORMAL") {
          centerOffsetHuman = Math.max(
            -p.maxCenterOffsetBins,
            Math.min(p.maxCenterOffsetBins, Math.round(-p.reversionGain * devBins)),
          );
        }
      }
      // Human offset → physical bin offset through the pool orientation.
      const targetCenterBin = pool.activeBinId + dir * centerOffsetHuman;

      // ---- 6. Quiet gating ------------------------------------------------
      const lowest = hasPosition
        ? pm.positionBins.reduce((m, b) => Math.min(m, b.binId), pm.positionBins[0]!.binId)
        : null;
      const highest = hasPosition
        ? pm.positionBins.reduce((m, b) => Math.max(m, b.binId), pm.positionBins[0]!.binId)
        : null;
      const outOfRange =
        hasPosition &&
        (pool.activeBinId < (lowest ?? pool.activeBinId) ||
          pool.activeBinId > (highest ?? pool.activeBinId));
      const positionCenter =
        hasPosition && lowest !== null && highest !== null
          ? Math.round((lowest + highest) / 2)
          : null;
      const drift =
        positionCenter !== null ? Math.abs(positionCenter - targetCenterBin) : Infinity;
      const shouldRecenter = !hasPosition || outOfRange || drift > toleranceBins;

      const stateCtx = buildStateCtx(
        readout.regime,
        nowMs,
        halfWidth,
        toleranceBins,
        p.maxCenterOffsetBins,
        p,
      );

      if (!shouldRecenter && !hasFees) {
        return {
          kind: "quiet",
          reason: `presenceAnchor: in range (drift=${drift}≤${toleranceBins}, regime=${readout.regime})`,
        };
      }

      // ---- 7. Weights around the target center ---------------------------
      const range = pickBinRange(targetCenterBin, halfWidth, p.maxHalfWidthBins + 4);
      const centerPrice = humanPriceForBin(orientation, targetCenterBin);
      const weights = computeBinWeights({
        bins: range.bins,
        orientation,
        activeBinId: pool.activeBinId,
        feeRateBps: pool.feeRateBps,
        distribution: {
          logMu: Math.log(centerPrice),
          sigma: sigmaH,
          horizonMs: p.horizonMs,
          estimator: coldStart ? "cold-start" : "ewma-anchor",
        },
      });

      // ---- 8. Capital + inventory steering --------------------------------
      // Deployable = idle balance + fees (when collecting) + injected
      // positionValue (execution layer's remove-proceeds re-plan).
      const grossA = pm.balance.a + (hasFees ? pm.feeBag.a : 0n) + (pm.positionValue?.a ?? 0n);
      const grossB = pm.balance.b + (hasFees ? pm.feeBag.b : 0n) + (pm.positionValue?.b ?? 0n);

      // base/quote → physical mapping: base is physical A on a normal pool,
      // physical B on an inverted pool (poolCoinAIsQuote).
      const inverted = orientation.poolCoinAIsQuote;
      const baseRaw = inverted ? grossB : grossA;
      const quoteRaw = inverted ? grossA : grossB;
      const baseDecimals = inverted ? orientation.poolCoinBDecimals : orientation.poolCoinADecimals;
      const quoteDecimals = inverted ? orientation.poolCoinADecimals : orientation.poolCoinBDecimals;

      const steer = steerInventory(baseRaw, quoteRaw, baseDecimals, quoteDecimals, spotPrice, p);

      // Ask side (BASE) sits in the bins the human price rises INTO = the
      // physical side holding base. Physical A lives above active; so the
      // ask side is above-active on a normal pool, below-active on an
      // inverted pool. Deployment fractions map accordingly.
      const capitalScale = readout.regime === "TREND" ? p.trendCapitalScale : 1;
      const fracAbove = (inverted ? steer.bidDeployFrac : steer.askDeployFrac) * capitalScale;
      const fracBelow = (inverted ? steer.askDeployFrac : steer.bidDeployFrac) * capitalScale;

      const deployA = mulFrac(grossA, fracAbove); // physical A → above-active bins
      const deployB = mulFrac(grossB, fracBelow); // physical B → below-active bins

      // ---- 9. Per-bin split (physical side rule, never the active bin) ----
      const aboveIdx: number[] = [];
      const belowIdx: number[] = [];
      weights.bins.forEach((b, i) => {
        if (b.binId > pool.activeBinId) aboveIdx.push(i);
        else if (b.binId < pool.activeBinId) belowIdx.push(i);
      });
      const aboveAmounts = splitProportional(deployA, aboveIdx.map((i) => weights.bins[i]!.weight));
      const belowAmounts = splitProportional(deployB, belowIdx.map((i) => weights.bins[i]!.weight));

      const finalBins: number[] = [];
      const finalA: bigint[] = [];
      const finalB: bigint[] = [];
      weights.bins.forEach((b, i) => {
        let a = 0n;
        let bb = 0n;
        const ai = aboveIdx.indexOf(i);
        const bi = belowIdx.indexOf(i);
        if (ai >= 0) a = aboveAmounts[ai] ?? 0n;
        if (bi >= 0) bb = belowAmounts[bi] ?? 0n;
        if (a === 0n && bb === 0n) return;
        finalBins.push(b.binId);
        finalA.push(a);
        finalB.push(bb);
      });

      const removeShares = new Map<number, bigint>();
      if (hasPosition) {
        for (const bin of pm.positionBins) {
          if (bin.liquidityShare > 0n) removeShares.set(bin.binId, bin.liquidityShare);
        }
      }

      if (finalBins.length === 0 && removeShares.size === 0 && !hasFees) {
        return { kind: "quiet", reason: "presenceAnchor: nothing deployable this tick" };
      }

      const reason =
        `presenceAnchor: ${readout.regime}${coldStart ? "/cold-start" : ""} ` +
        `center=${targetCenterBin} active=${pool.activeBinId} dev=${devBins.toFixed(2)}bins ` +
        `volRatio=${Number.isFinite(readout.volRatio) ? readout.volRatio.toFixed(2) : "n/a"} ` +
        `baseShare=${steer.baseShare.toFixed(2)}→${p.targetBaseShare} ` +
        `deploy(ask=${(inverted ? fracBelow : fracAbove).toFixed(2)},bid=${(inverted ? fracAbove : fracBelow).toFixed(2)}) ` +
        `halfWidth=${halfWidth} bins=${finalBins.length}`;

      const plan: RebalancePlan = {
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
      };

      return { kind: "plan_and_reconcile", plan, stateCtx };
    },
  };
}
