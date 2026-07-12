/**
 * presenceSweep strategy — the presence architecture fused with cdpm_web's
 * execution discipline ("presence3" in the operator's NAV-replay study).
 *
 * WHAT it adds over presenceAnchor (which it reuses for regime gates, anchor,
 * width, steering, TREND annealing and DEFENSE):
 *
 *  1. **Anchor-boundary state machine** (cdpm_web BidAsk with boundary :=
 *     the 4h anchor, so no user-configured boundary is needed): price above
 *     the anchor = HIGH state, below = LOW.
 *  2. **Flip-sweep**: when the state flips after the previous state persisted
 *     ≥ `sweepDwellMs` (1h — the measured OU half-life, a mechanism-derived
 *     constant), the coins converted near LOCAL prices are re-parked toward
 *     the anchor zone: HIGH → sold-high quote waits LOW to buy the dip;
 *     LOW → bought-low base waits HIGH to sell the bounce. This turns the
 *     strategy from constant-mix rebalancing (sell winners, rebuy high) into
 *     pullback accumulation — the NAV-replay matrix showed it flips the two
 *     bull cells from deeply negative to POSITIVE vs HODL.
 *  3. **fillBoundary freeze interval** (cdpm_web §8.3): the swept-into bins,
 *     recorded as ONE persisted number (`position_state.fill_boundary_bin_id`,
 *     the existing channel) spanning [boundary ↔ anchorBin]. Frozen bins are
 *     excluded from removes AND adds on subsequent ticks — the parked orders
 *     wait at anchor prices instead of being dragged along by requotes.
 *  4. **Unfreeze-on-fill**: a frozen bin the active bin has CROSSED has
 *     executed its parked order — its freeze is spent and the converted coin
 *     re-enters the free pool at the next rebalance. (Bin side is determined
 *     by position vs active — the protocol's physical layout — so this is
 *     stateless given the boundary number; the lifecycle bug this fixes was
 *     caught on the ETH-flat replay cell.)
 *  5. **Partial-remove diff plans**: regular rebalances keep frozen bins'
 *     shares untouched (`removeShares` excludes them) and rebuild only the
 *     free book — the execution layer's remove-proceeds re-plan works on the
 *     partial map as-is.
 *
 * Statelessness: everything except the single fillBoundary number is
 * recomputed from price history each tick (the dwell gate counts anchor
 * crossings inside the visible window; `historyWindowMs` is sized so every
 * scan point has a full anchor lookback). Restart-safe by construction;
 * DEFENSE clears the boundary.
 */

import type { Strategy, StrategyInput, StrategyOutput } from "./types.ts";
import type { RebalancePlan } from "../domain/types.ts";
import { computeBinWeights, pickBinRange } from "../forecast/binWeights.ts";
import { bucketToOhlcv, ewmaSigma, scaleSigmaToHorizon } from "../forecast/volatility.ts";
import { buildExtremeWithdrawPlan } from "../decision/diffPlanner.ts";
import {
  PRESENCE_DEFAULTS,
  type PresenceAnchorParams,
  type RegimeReadout,
  buildStateCtx,
  mulFrac,
  nowcastRegime,
  realizedSigma,
  splitProportional,
  steerInventory,
} from "./presenceAnchor.ts";
import {
  clearFillBoundary,
  loadPositionState,
  type PositionState,
} from "./positionState.ts";
import {
  binDirection,
  binIdForHumanPrice,
  humanPriceForBin,
  orientationOf,
} from "../domain/binMath.ts";
import { log } from "../lib/logger.ts";

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

export interface PresenceSweepParams extends PresenceAnchorParams {
  /**
   * A state flip only triggers the sweep when the previous state persisted
   * at least this long — noise crossings of the anchor in chop must not
   * thrash the freeze. Default 1h = the measured OU half-life against the
   * 4h anchor (mechanism-derived, not fitted).
   */
  sweepDwellMs?: number;
}

const SWEEP_DEFAULTS: Required<PresenceSweepParams> = {
  ...PRESENCE_DEFAULTS,
  sweepDwellMs: 60 * 60 * 1000,
};

/** Injectable persistence for tests (defaults to the real position_state). */
export interface PresenceSweepDeps {
  loadState?: (pmId: string) => PositionState | null;
  clearState?: (pmId: string) => void;
}

// ---------------------------------------------------------------------------
// Strategy factory
// ---------------------------------------------------------------------------

export function createPresenceSweepStrategy(
  params: PresenceSweepParams = {},
  deps: PresenceSweepDeps = {},
): Strategy {
  const p: Required<PresenceSweepParams> = { ...SWEEP_DEFAULTS, ...params };
  const loadState = deps.loadState ?? loadPositionState;
  const clearState = deps.clearState ?? clearFillBoundary;

  return {
    name: "presenceSweep",

    // Anchor window + the LONGER of (re-entry scan, sweep dwell) so both the
    // regime scan and the crossing counter have full anchor lookback.
    historyWindowMs: p.anchorWindowMs + Math.max(p.reentryCalmMs, p.sweepDwellMs),

    async plan(input: StrategyInput): Promise<StrategyOutput> {
      const { pm, pool, spot, history, profile } = input;

      const hasBalance = pm.balance.a > 0n || pm.balance.b > 0n;
      const hasPosition = pm.positionBins.length > 0;
      const hasFees = pm.feeBag.a > 0n || pm.feeBag.b > 0n;
      if (!hasBalance && !hasPosition && !hasFees) {
        return { kind: "quiet", reason: "presenceSweep: empty PM" };
      }
      const spotPrice = Number(spot.price);
      if (!Number.isFinite(spotPrice) || spotPrice <= 0) {
        return { kind: "quiet", reason: `presenceSweep: invalid spot price ${spot.price}` };
      }

      const orientation = orientationOf(profile);
      const dir = binDirection(orientation);
      const nowMs = spot.timestampMs;

      const bars = bucketToOhlcv(
        history.map((h) => ({ timestampMs: h.timestampMs, price: Number(h.price) })),
        60_000,
      );
      const spanMs =
        bars.length >= 2 ? bars[bars.length - 1]!.bucketStartMs - bars[0]!.bucketStartMs : 0;
      const coldStart = spanMs < p.minHistoryMs || bars.length < 30;

      const readout: RegimeReadout = coldStart
        ? { regime: "NORMAL", volRatio: Number.NaN, driftZ: Number.NaN, reentryBlocked: false }
        : nowcastRegime(bars, nowMs, p);

      // Width / tolerance from the anchor-window slice (same as presenceAnchor).
      const anchorBars = bars.filter((b) => b.bucketStartMs > nowMs - p.anchorWindowMs);
      const closes = anchorBars.map((b) => b.close);
      const sigmaPerBar = closes.length >= 2 ? ewmaSigma(closes) : 0.001;
      const sigmaH = scaleSigmaToHorizon(sigmaPerBar, 60_000, p.horizonMs);
      const logStep = Math.log(1 + profile.binStep / 10_000);
      const sigmaBins = sigmaH / logStep;
      let halfWidth = Math.max(
        p.minHalfWidthBins,
        Math.min(p.maxHalfWidthBins, Math.round(p.kW * sigmaBins)),
      );
      if (readout.regime === "TREND") {
        halfWidth = Math.min(Math.round(halfWidth * p.trendWidenFactor), p.maxHalfWidthBins + 4);
      }
      const toleranceBins = Math.min(Math.max(1, Math.round(sigmaBins)), halfWidth);

      // ---- DEFENSE: presence-only exit; the boundary is cleared ----------
      if (readout.regime === "DEFENSE") {
        try {
          clearState(pm.pmId);
        } catch (err) {
          log.warn("presenceSweep: clearFillBoundary failed (continuing)", {
            pmId: pm.pmId, err: String(err),
          });
        }
        const trig = `volRatio=${readout.volRatio.toFixed(2)} driftZ=${Number.isFinite(readout.driftZ) ? readout.driftZ.toFixed(2) : "n/a"}${readout.reentryBlocked ? ", re-entry blocked" : ""}`;
        const stateCtx = buildStateCtx("DEFENSE", nowMs, halfWidth, toleranceBins, p);
        const withdraw = buildExtremeWithdrawPlan(
          pm,
          `presenceSweep: DEFENSE full withdrawal (${trig})`,
        );
        if (!withdraw) {
          return {
            kind: "reconcile_only",
            reason: `presenceSweep: DEFENSE, nothing to withdraw (${trig})`,
            stateCtx,
          };
        }
        return { kind: "plan_and_reconcile", plan: withdraw, stateCtx };
      }

      // ---- Anchor, state, dwell-gated sweep decision ----------------------
      let centerOffsetHuman = 0;
      let devBins = 0;
      let anchorPrice = spotPrice;
      if (!coldStart) {
        const meanLog = closes.reduce((s, c) => s + Math.log(c), 0) / closes.length;
        anchorPrice = Math.exp(meanLog);
        devBins = (Math.log(spotPrice) - meanLog) / logStep;
        if (readout.regime === "NORMAL") {
          centerOffsetHuman = Math.max(
            -p.maxCenterOffsetBins,
            Math.min(p.maxCenterOffsetBins, Math.round(-p.reversionGain * devBins)),
          );
        }
      }
      const targetCenterBin = pool.activeBinId + dir * centerOffsetHuman;
      const activeBin = pool.activeBinId;
      const anchorBin = coldStart ? activeBin : binIdForHumanPrice(orientation, anchorPrice);
      const curState: "HIGH" | "LOW" = spotPrice >= anchorPrice ? "HIGH" : "LOW";

      // Parked coin for the CURRENT state: HIGH parks quote (waits to buy the
      // dip), LOW parks base (waits to sell the bounce). Physical side of the
      // parked coin's bins relative to active: quote = physical A when
      // poolCoinAIsQuote (above active) else physical B (below).
      const quoteIsA = orientation.poolCoinAIsQuote;
      const parkedAbove = curState === "HIGH" ? quoteIsA : !quoteIsA;

      // Crossing count inside the dwell window (stateless dwell gate): the
      // flip is sweep-worthy iff the visible dwell window contains at most
      // one sign change of (logp − anchor).
      let crossings = 0;
      if (!coldStart) {
        let prevSign = 0;
        for (const bar of bars) {
          const t = bar.bucketStartMs;
          if (t <= nowMs - p.sweepDwellMs) continue;
          const win = bars.filter(
            (b) => b.bucketStartMs > t - p.anchorWindowMs && b.bucketStartMs <= t,
          );
          if (win.length < 30) continue;
          const mean = win.reduce((s, b) => s + Math.log(b.close), 0) / win.length;
          const sign = Math.log(bar.close) >= mean ? 1 : -1;
          if (prevSign !== 0 && sign !== prevSign) crossings++;
          prevSign = sign;
        }
      }

      // Persisted boundary: trusted only when it was written by this strategy
      // and lies on the parked side of the anchor for the CURRENT state.
      let boundary: number | null = null;
      try {
        const st = loadState(pm.pmId);
        if (st && st.strategyName === "presenceSweep") boundary = st.fillBoundaryBinId;
      } catch (err) {
        log.warn("presenceSweep: loadPositionState failed (treating as no boundary)", {
          pmId: pm.pmId, err: String(err),
        });
      }
      const boundaryValid =
        boundary !== null && (parkedAbove ? boundary > anchorBin : boundary < anchorBin);

      // Sweep is due when the current state has no valid parked boundary and
      // the anchor neighbourhood is not choppy (≤1 crossing in the dwell
      // window). Covers both the fresh dwell-qualified flip and the
      // self-healing case (boundary lost/stale after DEFENSE or restart).
      const sweepDue = !coldStart && hasPosition !== false && crossings <= 1 && !boundaryValid;

      // Frozen bins: inside [boundary ↔ anchorBin] on the parked side of the
      // CURRENT active bin. A frozen bin the active has crossed has FILLED —
      // freeze spent, it re-enters the free pool (unfreeze-on-fill).
      const frozen = new Set<number>();
      if (!sweepDue && boundaryValid && boundary !== null) {
        const lo = Math.min(boundary, anchorBin);
        const hi = Math.max(boundary, anchorBin);
        for (const b of pm.positionBins) {
          if (b.binId < lo || b.binId > hi) continue;
          const stillParked = parkedAbove ? b.binId > activeBin : b.binId < activeBin;
          if (stillParked) frozen.add(b.binId);
        }
      }

      // ---- Quiet gating (never quiet when a sweep is due) -----------------
      const nonFrozenBins = pm.positionBins.filter((b) => !frozen.has(b.binId));
      const lowest = nonFrozenBins.length
        ? nonFrozenBins.reduce((m, b) => Math.min(m, b.binId), nonFrozenBins[0]!.binId)
        : null;
      const highest = nonFrozenBins.length
        ? nonFrozenBins.reduce((m, b) => Math.max(m, b.binId), nonFrozenBins[0]!.binId)
        : null;
      const outOfRange =
        nonFrozenBins.length > 0 &&
        (activeBin < (lowest ?? activeBin) || activeBin > (highest ?? activeBin));
      const posCenter =
        lowest !== null && highest !== null ? Math.round((lowest + highest) / 2) : null;
      const drift = posCenter !== null ? Math.abs(posCenter - targetCenterBin) : Infinity;

      const stateCtx = buildStateCtx(
        readout.regime, nowMs, halfWidth, toleranceBins, p,
      );
      if (!sweepDue && drift <= toleranceBins && !outOfRange && !hasFees) {
        return {
          kind: "quiet",
          reason: `presenceSweep: in range (drift=${drift}≤${toleranceBins}, regime=${readout.regime}, state=${curState})`,
        };
      }

      // ---- Build the plan --------------------------------------------------
      // Sweep: full rebuild (all bins removed, freeze reset around the new
      // parked placement). Regular: partial — frozen bins keep their shares.
      const removeShares = new Map<number, bigint>();
      for (const b of pm.positionBins) {
        if (!sweepDue && frozen.has(b.binId)) continue;
        if (b.liquidityShare > 0n) removeShares.set(b.binId, b.liquidityShare);
      }

      const grossA = pm.balance.a + (hasFees ? pm.feeBag.a : 0n) + (pm.positionValue?.a ?? 0n);
      const grossB = pm.balance.b + (hasFees ? pm.feeBag.b : 0n) + (pm.positionValue?.b ?? 0n);
      const inverted = orientation.poolCoinAIsQuote;
      const baseRaw = inverted ? grossB : grossA;
      const quoteRaw = inverted ? grossA : grossB;
      const baseDecimals = inverted ? orientation.poolCoinBDecimals : orientation.poolCoinADecimals;
      const quoteDecimals = inverted ? orientation.poolCoinADecimals : orientation.poolCoinBDecimals;
      const steer = steerInventory(baseRaw, quoteRaw, baseDecimals, quoteDecimals, spotPrice, p);

      const capitalScale = readout.regime === "TREND" ? p.trendCapitalScale : 1;
      const fracAbove = (inverted ? steer.bidDeployFrac : steer.askDeployFrac) * capitalScale;
      const fracBelow = (inverted ? steer.askDeployFrac : steer.bidDeployFrac) * capitalScale;
      const deployA = mulFrac(grossA, fracAbove);
      const deployB = mulFrac(grossB, fracBelow);

      const range = pickBinRange(targetCenterBin, halfWidth, p.maxHalfWidthBins + 4);
      const centerPrice = humanPriceForBin(orientation, targetCenterBin);
      const weights = computeBinWeights({
        bins: range.bins,
        orientation,
        activeBinId: activeBin,
        feeRateBps: pool.feeRateBps,
        distribution: {
          logMu: Math.log(centerPrice),
          sigma: sigmaH,
          horizonMs: p.horizonMs,
          estimator: coldStart ? "cold-start" : "ewma-anchor",
        },
      });

      const aboveIdx: number[] = [];
      const belowIdx: number[] = [];
      weights.bins.forEach((b, i) => {
        if (!sweepDue && frozen.has(b.binId)) return; // never top up frozen bins
        if (b.binId > activeBin) aboveIdx.push(i);
        else if (b.binId < activeBin) belowIdx.push(i);
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

      if (finalBins.length === 0 && removeShares.size === 0 && !hasFees) {
        return { kind: "quiet", reason: "presenceSweep: nothing deployable this tick" };
      }

      // fillBoundary: on a sweep, the farthest parked-side add becomes the new
      // boundary; otherwise re-emit the valid boundary so it stays fresh.
      let fillBoundary: number | undefined;
      if (sweepDue) {
        const parkedAdds = finalBins.filter((k) => (parkedAbove ? k > activeBin : k < activeBin));
        if (parkedAdds.length > 0) {
          fillBoundary = parkedAbove ? Math.max(...parkedAdds) : Math.min(...parkedAdds);
        }
      } else if (boundaryValid && boundary !== null) {
        fillBoundary = boundary;
      }

      const reason =
        `presenceSweep: ${readout.regime}${coldStart ? "/cold-start" : ""}${sweepDue ? "/SWEEP" : ""} ` +
        `state=${curState} center=${targetCenterBin} active=${activeBin} anchorBin=${anchorBin} ` +
        `dev=${devBins.toFixed(2)}bins crossings=${crossings} frozen=${frozen.size} ` +
        `baseShare=${steer.baseShare.toFixed(2)} halfWidth=${halfWidth} bins=${finalBins.length}`;

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
        plannedActiveBinId: activeBin,
      };

      return { kind: "plan_and_reconcile", plan, fillBoundary, stateCtx };
    },
  };
}
