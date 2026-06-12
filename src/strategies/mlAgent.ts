/**
 * mlAgent strategy — W2/W6 ML integration.
 *
 * Orchestrates the three-state machine, risk monitor, prediction provider,
 * and diff-planner into a single strategy that the rebalancer can call like
 * any other Strategy implementation.
 *
 * Fallback / probation semantics (implementation-plan-v1.md §4.2):
 *   - When pred.fallback !== false, increment the per-pool episode counter,
 *     mark the pool as in-probation, and delegate to the Tier 0 fallback
 *     strategy.
 *   - While in probation, every successful inference (pred.fallback === false
 *     AND pred.psi < 0.25) increments a "consecutive success" counter.
 *     After 3 consecutive successes the pool exits probation.
 *   - PSI too high during probation resets the success streak.
 *
 * Every inference is persisted to the `predictions` table (even fallbacks).
 * DB write failures are logged as warnings and do NOT abort the tick.
 */

import type { Strategy, StrategyInput, StrategyOutput } from "./types.ts";
import type { PredictionProvider } from "../prediction/provider.ts";
import type { StateMachine } from "../state/machine.ts";
import type { RiskMonitor } from "../risk/monitor.ts";
import type { MarketAggregator } from "../data/marketAggregator.ts";
import type { Database } from "bun:sqlite";
import { DataOutageError } from "../data/marketAggregator.ts";
import { diffPlan } from "../decision/diffPlanner.ts";
import { log } from "../lib/logger.ts";
import type { PmRangeContext } from "../prediction/types.ts";
import type { ExtremeSignal } from "../state/transitions.ts";

export interface MlAgentDeps {
  provider: PredictionProvider;
  stateMachine: StateMachine;
  riskMonitor: RiskMonitor;
  marketAggregator: MarketAggregator;
  /** Tier 0 rule-based strategy used when inference is degraded or in probation. */
  fallback: Strategy;
  db?: Database;
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
}

/**
 * PSI threshold below which a prediction is considered healthy enough to
 * count as a "successful inference" for probation exit.
 */
const PSI_PROBATION_EXIT_THRESHOLD = 0.25;

/** Number of consecutive successful inferences required to exit probation. */
const PROBATION_EXIT_SUCCESSES = 3;

export function createMlAgentStrategy(deps: MlAgentDeps): Strategy {
  // Per-pool probation tracking (in-memory; reset on process restart).
  const fallbackEpisodeCount: Record<string, number> = {};
  const inProbation: Record<string, boolean> = {};
  const consecutiveSuccessCount: Record<string, number> = {};

  return {
    name: "mlAgent",

    async plan(input: StrategyInput): Promise<StrategyOutput> {
      const { provider, stateMachine, riskMonitor, marketAggregator, fallback, db } = deps;
      const nowFn = deps.now ?? (() => Date.now());
      const poolId = input.pm.poolId;

      // -----------------------------------------------------------------------
      // L3 emergency veto — highest priority; abort before any I/O.
      // -----------------------------------------------------------------------
      const veto = riskMonitor.checkPreTick(input);
      if (veto?.kind === "emergency") {
        log.warn("mlAgent: L3 emergency veto, returning quiet", { poolId, reason: veto.reason });
        return { kind: "quiet", reason: veto.reason };
      }

      // -----------------------------------------------------------------------
      // Fetch market snapshot — throws DataOutageError if feeds never populated.
      // -----------------------------------------------------------------------
      let snapshot;
      try {
        snapshot = marketAggregator.latest();
      } catch (err) {
        if (err instanceof DataOutageError) {
          log.warn("mlAgent: DataOutageError, returning quiet", { poolId, reason: err.message });
          return { kind: "quiet", reason: err.message };
        }
        throw err;
      }

      // -----------------------------------------------------------------------
      // Build PmRangeContext from current input.
      // -----------------------------------------------------------------------
      const rangeCtx: PmRangeContext = {
        pmId: input.pm.pmId,
        activeBin: input.pool.activeBinId,
        binStep: input.pool.binStep,
        currentBins: input.pm.positionBins.map((b) => b.binId),
      };

      // -----------------------------------------------------------------------
      // Run inference (timed).
      // -----------------------------------------------------------------------
      const t0 = nowFn();
      const pred = await provider.predict(snapshot, rangeCtx);
      const inferMs = nowFn() - t0;

      // -----------------------------------------------------------------------
      // Compact snapshot digest for the DB row (not for security, just tracing).
      // -----------------------------------------------------------------------
      const snapshotDigest = JSON.stringify([
        snapshot.ts,
        snapshot.cetus.activeBin,
        snapshot.cetus.price,
        snapshot.cetus.tvlUsd,
        snapshot.spread,
        snapshot.derivatives.funding,
      ]).slice(0, 32);

      // -----------------------------------------------------------------------
      // Probation tracking.
      // -----------------------------------------------------------------------
      const isFallback = pred.fallback !== false;
      if (isFallback) {
        fallbackEpisodeCount[poolId] = (fallbackEpisodeCount[poolId] ?? 0) + 1;
        if (!inProbation[poolId]) {
          log.warn("mlAgent: entering probation", {
            poolId,
            reason: pred.fallback,
            episodeCount: fallbackEpisodeCount[poolId],
          });
        }
        inProbation[poolId] = true;
        consecutiveSuccessCount[poolId] = 0;
      } else if (inProbation[poolId]) {
        // Successful inference while in probation — check PSI.
        if (pred.psi < PSI_PROBATION_EXIT_THRESHOLD) {
          consecutiveSuccessCount[poolId] = (consecutiveSuccessCount[poolId] ?? 0) + 1;
          if (consecutiveSuccessCount[poolId] >= PROBATION_EXIT_SUCCESSES) {
            inProbation[poolId] = false;
            consecutiveSuccessCount[poolId] = 0;
            log.info("mlAgent: exiting probation after consecutive successes", {
              poolId,
              episodeCount: fallbackEpisodeCount[poolId],
            });
          }
        } else {
          // PSI too high — reset success streak.
          consecutiveSuccessCount[poolId] = 0;
        }
      }

      // -----------------------------------------------------------------------
      // Persist prediction to DB.
      // -----------------------------------------------------------------------
      if (db) {
        try {
          db.prepare(`
            INSERT INTO predictions (
              pool_id, ts_ms, model_version, active_bin,
              center_q10, center_q50, center_q90, width_sigma,
              p_above, p_below, feature_completeness, psi,
              fallback, infer_ms, snapshot_digest
            ) VALUES (
              ?, ?, ?, ?,
              ?, ?, ?, ?,
              ?, ?, ?, ?,
              ?, ?, ?
            )
          `).run(
            poolId,
            snapshot.ts,
            pred.modelVersion,
            snapshot.cetus.activeBin,
            pred.centerQ10,
            pred.centerOffset,
            pred.centerQ90,
            pred.widthSigma,
            pred.pAbove,
            pred.pBelow,
            pred.featureCompleteness,
            pred.psi,
            isFallback ? String(pred.fallback) : null,
            inferMs,
            snapshotDigest,
          );
        } catch (dbErr) {
          log.warn("mlAgent: DB write failed, continuing", { poolId, err: String(dbErr) });
        }
      }

      // -----------------------------------------------------------------------
      // Delegate to fallback when degraded or in probation.
      // -----------------------------------------------------------------------
      if (isFallback || inProbation[poolId]) {
        return fallback.plan(input);
      }

      // -----------------------------------------------------------------------
      // Build ExtremeSignal from L2 veto (if applicable).
      // -----------------------------------------------------------------------
      let extremeSignal: ExtremeSignal | null = null;
      if (veto?.kind === "extreme") {
        extremeSignal = { active: true, trigger: veto.trigger };
      }

      // -----------------------------------------------------------------------
      // Advance the three-state machine.
      // -----------------------------------------------------------------------
      const ctx = stateMachine.advance(snapshot, pred, input, extremeSignal);

      // -----------------------------------------------------------------------
      // Apply L1 soft veto adjustments to the derived context.
      // -----------------------------------------------------------------------
      let adjustedCtx = ctx;
      if (veto?.kind === "soft") {
        adjustedCtx = {
          ...ctx,
          halfWidth: Math.max(2, Math.round(ctx.halfWidth * veto.halfWidthFactor)),
          lendingPct: Math.min(1, ctx.lendingPct + veto.lendingPctBonusPp / 100),
        };
      }

      // -----------------------------------------------------------------------
      // EXTREME state: full withdrawal plan, no re-add.
      // -----------------------------------------------------------------------
      if (ctx.state === "EXTREME") {
        const plan = diffPlan({
          pm: input.pm,
          pool: input.pool,
          ctx: adjustedCtx,
          pred,
          profile: input.profile,
        });
        if (!plan) return { kind: "quiet", reason: "EXTREME: below min threshold" };
        return { kind: "plan_and_reconcile", plan, fillBoundary: input.pool.activeBinId };
      }

      // -----------------------------------------------------------------------
      // Normal / Trend path.
      // -----------------------------------------------------------------------
      const plan = diffPlan({
        pm: input.pm,
        pool: input.pool,
        ctx: adjustedCtx,
        pred,
        profile: input.profile,
      });
      if (!plan) return { kind: "quiet", reason: "below min threshold" };

      // fillBoundary: active bin shifted by the predicted center offset.
      const fillBoundary = input.pool.activeBinId + Math.round(pred.centerOffset);

      return {
        kind: "plan_and_reconcile",
        plan,
        fillBoundary,
      };
    },
  };
}
