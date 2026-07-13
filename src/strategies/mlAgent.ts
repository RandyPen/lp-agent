/**
 * mlAgent strategy — W2/W6 ML integration.
 *
 * Orchestrates the three-state machine, risk monitor, prediction provider,
 * and diff-planner into a single strategy that the rebalancer can call like
 * any other Strategy implementation.
 *
 * Fallback / probation semantics (implementation-plan-v1.md §4.2):
 *   - When pred.fallback !== false, increment the per-pool fallback-tick counter,
 *     mark the pool as in-probation, and delegate to the Tier 0 fallback
 *     strategy.
 *   - While in probation, every successful inference (pred.fallback === false
 *     AND pred.psi < 0.25) increments a "consecutive success" counter.
 *     After 3 consecutive successes the pool exits probation.
 *   - PSI too high during probation resets the success streak.
 *
 * Every inference is persisted to the `predictions` table (even fallbacks).
 * The `executed_path` column records which strategy actually produced the
 * output for each tick ('model' | 'tier0_fallback' | 'tier0_probation').
 * DB write failures are logged as warnings and do NOT abort the tick.
 *
 * Probation state is rehydrated from the DB on the first plan() call for a
 * pool. See rehydrateProbationState() for the exact reconstruction rule.
 */

import type { Strategy, StrategyInput, StrategyOutput } from "./types.ts";
import type { PredictionProvider } from "../prediction/provider.ts";
import type { StateMachine } from "../state/machine.ts";
import type { RiskMonitor } from "../risk/monitor.ts";
import type { MarketAggregator } from "../data/marketAggregator.ts";
import type { Database } from "bun:sqlite";
import { DataOutageError } from "../data/marketAggregator.ts";
import {
  buildExtremeWithdrawPlan,
  computeTargetCenterBin,
  diffPlan,
  type DiffPlanInput,
} from "../decision/diffPlanner.ts";
import { evaluateAllLots, getForceLiquidations } from "../decision/ageStopLoss.ts";
import { loadOpenLots } from "../decision/lotStore.ts";
import { binDirection, orientationOf } from "../domain/binMath.ts";
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
  /**
   * Optional 24h PnL fraction provider for a pool. Returns the fractional PnL
   * (e.g. -0.05 = -5%) or null when not available.
   *
   * Only wire this when genuine fractional PnL is available — do NOT fabricate
   * a value by converting absolute USD PnL without a portfolio-value denominator
   * (that would feed a dishonest signal into the L2 pnl_24h circuit breaker).
   * Wiring lands with W7 PnL attribution; leave null until then.
   */
  get24hPnlPct?: (poolId: string) => number | null;
}

/**
 * PSI threshold below which a prediction is considered healthy enough to
 * count as a "successful inference" for probation exit.
 */
const PSI_PROBATION_EXIT_THRESHOLD = 0.25;

/** Number of consecutive successful inferences required to exit probation. */
const PROBATION_EXIT_SUCCESSES = 3;

/**
 * How many recent predictions rows to inspect when rehydrating probation state
 * on a process restart. Must be >= PROBATION_EXIT_SUCCESSES to avoid
 * prematurely clearing probation when the tail of the window is all successes
 * but an earlier fallback exists within rehydration range.
 *
 * We look back REHYDRATION_WINDOW rows and walk them newest-to-oldest to find
 * the last fallback tick; if it occurred within the last PROBATION_EXIT_SUCCESSES
 * rows (i.e. < 3 consecutive successes after it) we start in probation.
 */
const REHYDRATION_WINDOW = 10;

// ---------------------------------------------------------------------------
// Rehydration helpers
// ---------------------------------------------------------------------------

/**
 * Row type returned by the rehydration query.
 *
 * `executed_path` may be NULL for rows written before the column was added
 * (pre-upgrade rows). The cold-start rule for those rows is: treat any row
 * with `fallback IS NOT NULL` as a fallback tick regardless of executed_path.
 */
interface PredictionRow {
  executed_path: string | null;
  fallback: string | null;
  psi: number;
}

/**
 * Rehydrate probation state for a single pool from recent DB rows.
 *
 * Reconstruction rule (newest-first scan):
 *   1. Query the last REHYDRATION_WINDOW rows for the pool, newest first.
 *   2. Walk from the newest row outward:
 *      - Count "clean success" ticks: rows where executed_path = 'model'
 *        (for new rows) OR (executed_path IS NULL AND fallback IS NULL AND
 *        psi < PSI_PROBATION_EXIT_THRESHOLD) (conservative rule for pre-upgrade
 *        rows).  A non-clean tick (fallback or probation delegation) stops the
 *        streak immediately.
 *      - If we encounter a fallback or probation-delegation row before reaching
 *        PROBATION_EXIT_SUCCESSES clean ticks, the pool is in probation. The
 *        consecutiveSuccessCount is the number of clean ticks seen before the
 *        fallback.
 *   3. If the table is empty or all rows in the window are clean successes ≥
 *      PROBATION_EXIT_SUCCESSES, the pool is NOT in probation.
 *
 * Conservative bias: pre-upgrade rows (executed_path IS NULL) with fallback IS
 * NOT NULL are treated as fallback ticks. This is the right default for a
 * custody product — false positives (unnecessary probation) are far less
 * harmful than false negatives (skipping required probation after a restart).
 *
 * @returns { inProbation, consecutiveSuccessCount }
 */
function rehydrateProbationState(
  db: Database,
  poolId: string,
): { inProbation: boolean; consecutiveSuccessCount: number } {
  let rows: PredictionRow[];
  try {
    rows = db
      .prepare<PredictionRow, [string, number]>(
        `SELECT executed_path, fallback, psi
         FROM predictions
         WHERE pool_id = ?
         ORDER BY ts_ms DESC
         LIMIT ?`,
      )
      .all(poolId, REHYDRATION_WINDOW);
  } catch (err) {
    // DB not available or table missing — conservative: don't assume clean.
    log.warn("mlAgent: rehydration query failed, defaulting to not-in-probation", {
      poolId,
      err: String(err),
    });
    return { inProbation: false, consecutiveSuccessCount: 0 };
  }

  if (rows.length === 0) {
    // Cold start: no history → not in probation.
    return { inProbation: false, consecutiveSuccessCount: 0 };
  }

  // Walk rows newest-first, counting consecutive clean successes.
  let streak = 0;
  for (const row of rows) {
    const isCleanSuccess = isCleanSuccessRow(row);
    if (isCleanSuccess) {
      streak++;
      if (streak >= PROBATION_EXIT_SUCCESSES) {
        // Enough consecutive successes — not in probation.
        return { inProbation: false, consecutiveSuccessCount: 0 };
      }
    } else {
      // Fallback or probation-delegation row found before we cleared the streak.
      return { inProbation: true, consecutiveSuccessCount: streak };
    }
  }

  // Walked the full window without an early return: every scanned row was a
  // clean success, and the streak never reached PROBATION_EXIT_SUCCESSES (3)
  // inside the loop. Since REHYDRATION_WINDOW (10) > PROBATION_EXIT_SUCCESSES,
  // the ONLY way to reach here is rows.length < PROBATION_EXIT_SUCCESSES
  // (otherwise the streak>=3 branch above would already have returned) — i.e.
  // we've seen the entire available history (fewer rows exist than a full
  // window) and none of it was a fallback. Not in probation.
  //
  // (This function used to branch here on `rows.length < REHYDRATION_WINDOW`
  // with a second "partial window, stay in probation" arm — but that
  // condition always holds at this point given the window/streak sizes
  // above, so the other arm was dead code. Removed rather than left
  // unreachable; the probation-decision logic itself is unchanged.)
  return { inProbation: false, consecutiveSuccessCount: 0 };
}

/**
 * Returns true if a predictions row represents a "clean success" for the
 * purposes of probation exit streak counting.
 *
 * For new rows (executed_path present): only 'model' counts as clean.
 * For pre-upgrade rows (executed_path IS NULL): fallback IS NULL AND psi < threshold.
 */
function isCleanSuccessRow(row: PredictionRow): boolean {
  if (row.executed_path !== null) {
    return row.executed_path === "model";
  }
  // Pre-upgrade row — conservative fallback rule.
  return row.fallback === null && row.psi < PSI_PROBATION_EXIT_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMlAgentStrategy(deps: MlAgentDeps): Strategy {
  // Per-pool probation tracking. Rehydrated from DB on first plan() call.
  const fallbackTickCount: Record<string, number> = {};
  const inProbation: Record<string, boolean> = {};
  const consecutiveSuccessCount: Record<string, number> = {};
  /** Tracks which pools have had their probation state rehydrated from DB. */
  const rehydrated: Record<string, boolean> = {};

  return {
    name: "mlAgent",

    async plan(input: StrategyInput): Promise<StrategyOutput> {
      const { provider, stateMachine, riskMonitor, marketAggregator, fallback, db } = deps;
      const nowFn = deps.now ?? (() => Date.now());
      const poolId = input.pm.poolId;

      // -----------------------------------------------------------------------
      // Rehydrate probation state from DB on first plan() call for this pool.
      // -----------------------------------------------------------------------
      if (!rehydrated[poolId] && db) {
        const { inProbation: wasInProbation, consecutiveSuccessCount: streak } =
          rehydrateProbationState(db, poolId);
        inProbation[poolId] = wasInProbation;
        consecutiveSuccessCount[poolId] = streak;
        // fallbackTickCount is an in-memory cumulative counter; starts at 0 on
        // restart (it is used only for log context, not for decision logic).
        fallbackTickCount[poolId] = 0;
        rehydrated[poolId] = true;
        if (wasInProbation) {
          log.info("mlAgent: rehydrated probation state from DB", {
            poolId,
            consecutiveSuccessCount: streak,
          });
        }
      }

      // -----------------------------------------------------------------------
      // L3 emergency veto — highest priority; abort before any I/O.
      // -----------------------------------------------------------------------
      const veto = riskMonitor.checkPreTick(input);
      if (veto?.kind === "emergency") {
        log.warn("mlAgent: L3 HALTED, returning quiet", { poolId, reason: veto.reason });
        return { kind: "quiet", reason: veto.reason };
      }
      if (veto?.kind === "drain") {
        // L3 just tripped. Do NOT plan — the rebalancer owns the emergency exit
        // and bypasses the strategy entirely while draining. Going quiet here
        // hands control back to it; it picks the drain up on the next tick.
        // (Rule-based strategies drain in the same tick because the rebalancer
        // sees this veto directly; mlAgent evaluates it internally, so its exit
        // starts one tick later.)
        log.error("mlAgent: L3 DRAINING — yielding to the rebalancer's emergency exit", {
          poolId,
          reason: veto.reason,
        });
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
      // Feed snapshot into risk monitor BEFORE inference (F1).
      // observeForPool must be called with an explicit poolId so the per-pool
      // rolling windows are warm before checkPreTick evaluates the same tick.
      // We pass the prediction below (after inference); this pre-call covers
      // the price/TVL/spread windows with the latest snapshot timestamp.
      // -----------------------------------------------------------------------
      riskMonitor.observeForPool(poolId, snapshot);

      // -----------------------------------------------------------------------
      // Run inference (timed).
      // -----------------------------------------------------------------------
      const t0 = nowFn();
      const pred = await provider.predict(snapshot, rangeCtx);
      const inferMs = nowFn() - t0;

      // -----------------------------------------------------------------------
      // Feed prediction into risk monitor (F1).
      // Now that we have the prediction, call observeForPool again so the
      // pBreakSum window is updated before the state machine evaluates.
      // This second call is cheap (no duplicate price/TVL entries are added
      // since the ts is the same as the first call; only pred fields are updated).
      // -----------------------------------------------------------------------
      if (pred.fallback === false) {
        riskMonitor.observeForPool(poolId, snapshot, pred);
      }

      // -----------------------------------------------------------------------
      // Update 24h PnL if a genuine fraction provider is wired (F1).
      // Only set when a real pct value is available — no fabricated conversion.
      // -----------------------------------------------------------------------
      if (deps.get24hPnlPct) {
        const pnlPct = deps.get24hPnlPct(poolId);
        if (pnlPct !== null) {
          riskMonitor.set24hPnl(poolId, pnlPct);
        }
      }

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
      // Probation tracking — determine the executed_path BEFORE the DB write.
      // -----------------------------------------------------------------------
      const isFallback = pred.fallback !== false;
      let executedPath: "model" | "tier0_fallback" | "tier0_probation";

      if (isFallback) {
        fallbackTickCount[poolId] = (fallbackTickCount[poolId] ?? 0) + 1;
        if (!inProbation[poolId]) {
          log.warn("mlAgent: entering probation", {
            poolId,
            reason: pred.fallback,
            fallbackTicks: fallbackTickCount[poolId],
          });
        }
        inProbation[poolId] = true;
        consecutiveSuccessCount[poolId] = 0;
        // A fresh fallback tick triggers (or continues) probation; Tier 0 executes.
        executedPath = "tier0_fallback";
      } else if (inProbation[poolId]) {
        // Successful inference while in probation — check PSI.
        if (pred.psi < PSI_PROBATION_EXIT_THRESHOLD) {
          consecutiveSuccessCount[poolId] = (consecutiveSuccessCount[poolId] ?? 0) + 1;
          if (consecutiveSuccessCount[poolId] >= PROBATION_EXIT_SUCCESSES) {
            inProbation[poolId] = false;
            consecutiveSuccessCount[poolId] = 0;
            log.info("mlAgent: exiting probation after consecutive successes", {
              poolId,
              fallbackTicks: fallbackTickCount[poolId],
            });
          }
        } else {
          // PSI too high — reset success streak.
          consecutiveSuccessCount[poolId] = 0;
        }
        // Still in probation after PSI evaluation: Tier 0 executes.
        // If probation just cleared (inProbation[poolId] is now false), this
        // tick itself was the 3rd success — but the delegation below also checks
        // inProbation[poolId], so the model runs on this tick if probation cleared.
        executedPath = inProbation[poolId] ? "tier0_probation" : "model";
      } else {
        executedPath = "model";
      }

      // -----------------------------------------------------------------------
      // Persist prediction to DB (after executedPath is known).
      // -----------------------------------------------------------------------
      if (db) {
        try {
          db.prepare(`
            INSERT INTO predictions (
              pool_id, ts_ms, model_version, active_bin,
              width_sigma, p_above, p_below,
              feature_completeness, psi,
              fallback, executed_path, infer_ms, snapshot_digest
            ) VALUES (
              ?, ?, ?, ?,
              ?, ?, ?,
              ?, ?,
              ?, ?, ?, ?
            )
          `).run(
            poolId,
            snapshot.ts,
            pred.modelVersion,
            snapshot.cetus.activeBin,
            pred.widthSigma,
            pred.pAbove,
            pred.pBelow,
            pred.featureCompleteness,
            pred.psi,
            isFallback ? String(pred.fallback) : null,
            executedPath,
            inferMs,
            snapshotDigest,
          );
        } catch (dbErr) {
          log.warn("mlAgent: DB write failed, continuing", { poolId, err: String(dbErr) });
        }
      }

      // -----------------------------------------------------------------------
      // Delegate to fallback when degraded or in probation.
      //
      // CRITICAL: the L2 EXTREME veto must survive delegation. The fallback
      // strategies have no EXTREME concept, so returning fallback.plan()
      // unconditionally would drop the protective full-withdrawal exactly when
      // the sidecar is down — which is often correlated with market stress.
      // -----------------------------------------------------------------------
      if (isFallback || inProbation[poolId]) {
        if (veto?.kind === "extreme") {
          const withdrawPlan = buildExtremeWithdrawPlan(
            input.pm,
            `EXTREME full withdrawal (L2 during fallback): ${veto.trigger}`,
          );
          if (!withdrawPlan) {
            return {
              kind: "quiet",
              reason: `L2 EXTREME active during fallback (nothing to withdraw): ${veto.trigger}`,
            };
          }
          log.warn("mlAgent: L2 EXTREME during fallback — issuing full withdrawal", {
            poolId,
            trigger: veto.trigger,
          });
          return { kind: "plan_and_reconcile", plan: withdrawPlan, fillBoundary: input.pool.activeBinId };
        }
        if (veto?.kind === "soft") {
          // Rule strategies have no halfWidth knob — the L1 soft adjustments
          // are not applicable. Logged as a known limitation; the lending-pct
          // bonus is likewise dropped on this path.
          log.info("mlAgent: L1 soft circuit active during fallback (adjustments not applicable)", {
            poolId,
          });
        }
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
      // volRecovered is supplied from the risk monitor (F2) — this replaces the
      // former heuristic p-sum proxy in machine.ts.
      // -----------------------------------------------------------------------
      const isVolRecovered = riskMonitor.volRecovered(poolId);
      const ctx = stateMachine.advance(snapshot, pred, input, extremeSignal, isVolRecovered);

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
        return {
          kind: "plan_and_reconcile",
          plan,
          fillBoundary: input.pool.activeBinId,
          stateCtx: adjustedCtx,
        };
      }

      // -----------------------------------------------------------------------
      // Age stop-loss (C2): evaluate the lot book and derive directives for
      // the planner. Skipped without a DB (no lot persistence) and on the
      // EXTREME path above (full withdrawal supersedes any stop-loss).
      // -----------------------------------------------------------------------
      let stopLoss: DiffPlanInput["stopLoss"];
      if (db) {
        try {
          const lots = loadOpenLots(db, input.pm.pmId);
          if (lots.length > 0) {
            const dir = binDirection(orientationOf(input.profile));
            const priceCtx = {
              activeBin: input.pool.activeBinId,
              currentMidPrice: Number(input.spot.price),
              binStep: input.pool.binStep,
              direction: dir,
            };
            const decisions = evaluateAllLots(lots, priceCtx, nowFn());
            const forced = getForceLiquidations(decisions);
            const relaxed = decisions.filter(
              (d): d is Extract<typeof d, { kind: "relax_ask_floor" }> =>
                d.kind === "relax_ask_floor",
            );
            if (forced.length > 0 || relaxed.length > 0) {
              // The operative relaxed floor is the one CLOSEST to active in
              // the rising-price direction (the least demanding minimum).
              const floors = relaxed.map((d) => d.relaxedAskBinId);
              const relaxedAskFloorBin =
                floors.length === 0
                  ? null
                  : dir === 1
                    ? Math.min(...floors)
                    : Math.max(...floors);
              stopLoss = {
                relaxedAskFloorBin,
                forceLiquidationBins: [...new Set(forced.map((f) => f.forcedAskBinId))],
              };
              log.warn("mlAgent: age stop-loss active", {
                poolId,
                pmId: input.pm.pmId,
                forced: forced.length,
                relaxed: relaxed.length,
                reasons: [...forced, ...relaxed].slice(0, 3).map((d) => d.reason),
              });
            }
          }
        } catch (lotErr) {
          // Lot bookkeeping must never veto a tick — log loudly and proceed.
          log.error("mlAgent: lot evaluation failed, proceeding without stop-loss", {
            poolId,
            err: String(lotErr),
          });
        }
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
        stopLoss,
      });
      if (!plan) return { kind: "quiet", reason: "below min threshold" };

      // fillBoundary: the SAME center diffPlan actually built the position
      // around (F10). Since the center-prediction removal this is always the
      // active bin; the shared helper keeps the invariant greppable.
      const fillBoundary = computeTargetCenterBin(
        adjustedCtx.state,
        input.pool.activeBinId,
      );

      return {
        kind: "plan_and_reconcile",
        plan,
        fillBoundary,
        stateCtx: adjustedCtx,
      };
    },
  };
}
