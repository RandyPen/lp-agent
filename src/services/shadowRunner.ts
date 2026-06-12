/**
 * src/services/shadowRunner.ts
 *
 * Shadow mode runner for the mlAgent strategy (v1 ML validation, W2–W4).
 *
 * In shadow mode the mlAgent strategy runs normally through the full decision
 * chain — prediction, state machine, diffPlanner — but NO on-chain transactions
 * are submitted. Each shadow tick records:
 *   - The mlAgent's StrategyOutput (what it WOULD have done).
 *   - The fallback/rule strategy's StrategyOutput (for comparison baseline).
 *   - Derived state parameters: market_state, lending_pct, half_width, trend_bias.
 *
 * The ShadowRunner wraps the existing rebalancer strategy decision path. It is
 * wired in by index.ts when `cfg.ml.shadowMode === true && cfg.strategy === "mlAgent"`.
 *
 * Design notes:
 *   - Shadow mode is deliberately NOT integrated into the regular `tickOne` loop
 *     so that adding shadow mode cannot accidentally start submitting PTBs if a
 *     flag is misconfigured.
 *   - The rebalancer's `tickOne` continues to run the LIVE strategy (rule-based)
 *     as before; the ShadowRunner runs in parallel for observability only.
 *   - DB write failures are logged as warnings and do NOT abort the shadow tick.
 */

import type { Database } from "bun:sqlite";
import type { Strategy, StrategyInput, StrategyOutput } from "../strategies/types.ts";
import type { StateMachine } from "../state/machine.ts";
import type { RebalancePlan } from "../domain/types.ts";
import { log } from "../lib/logger.ts";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface ShadowRunner {
  /**
   * Run the shadow tick for a single PM. Records both the mlAgent output and
   * the rule-based comparison output to `shadow_decisions` but NEVER submits
   * any on-chain transactions.
   */
  runShadowTick(input: StrategyInput): Promise<void>;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface ShadowRunnerDeps {
  /** The mlAgent strategy (already constructed with its PredictionProvider, etc.). */
  mlStrategy: Strategy;
  /** The rule-based fallback strategy used as the comparison baseline. */
  ruleStrategy: Strategy;
  /** The state machine used by mlAgent (read `.current()` after the decision). */
  stateMachine: StateMachine;
  /** SQLite database for writing shadow_decisions rows. */
  db: Database;
  /** Injectable clock for tests. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

/** JSON.stringify replacer that handles bigint → string. */
function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/**
 * Serialize a StrategyOutput to a JSON string suitable for the DB.
 * RebalancePlan.removeShares (Map) is converted to a plain object.
 */
function serializeStrategyOutput(output: StrategyOutput): string {
  if (output.kind === "quiet" || output.kind === "reconcile_only") {
    return JSON.stringify({ kind: output.kind, reason: output.reason }, bigintReplacer);
  }

  const plan = output.plan;
  const plainPlan: Record<string, unknown> = {
    pmId: plan.pmId,
    removeShares: Object.fromEntries(
      Array.from(plan.removeShares.entries()).map(([k, v]) => [k.toString(), v]),
    ),
    addAmountA: plan.addAmountA,
    addAmountB: plan.addAmountB,
    addBins: plan.addBins,
    addAmountsA: plan.addAmountsA,
    addAmountsB: plan.addAmountsB,
    collectFees: plan.collectFees,
    reason: plan.reason,
  };

  return JSON.stringify(
    {
      kind: output.kind,
      plan: plainPlan,
      fillBoundary: output.fillBoundary,
    },
    bigintReplacer,
  );
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createShadowRunner(deps: ShadowRunnerDeps): ShadowRunner {
  const { mlStrategy, ruleStrategy, stateMachine, db } = deps;
  const nowFn = deps.now ?? (() => Date.now());

  // Prepare the insert statement lazily so that a closed/invalid DB at
  // construction time doesn't throw here — it throws at the first tick, where
  // the error is caught and logged as a warning (non-fatal).
  let insertShadow: ReturnType<typeof db.prepare> | null = null;
  function getInsert(): ReturnType<typeof db.prepare> {
    if (!insertShadow) {
      insertShadow = db.prepare(`
        INSERT INTO shadow_decisions (
          pool_id, pm_id, ts_ms,
          market_state, strategy_output_kind, strategy_output_json,
          rule_output_kind, rule_output_json,
          lending_pct, half_width, trend_bias,
          model_version, created_at_ms
        ) VALUES (
          ?, ?, ?,
          ?, ?, ?,
          ?, ?,
          ?, ?, ?,
          ?, ?
        )
      `);
    }
    return insertShadow;
  }

  async function runShadowTick(input: StrategyInput): Promise<void> {
    const poolId = input.pm.poolId;
    const pmId = input.pm.pmId;
    const tickMs = nowFn();

    // Run both strategies concurrently for efficiency — neither submits
    // on-chain ops in shadow mode (mlAgent handles this via its own guard;
    // ruleStrategy is rule-based and has no on-chain side-effects in plan()).
    let mlOutput: StrategyOutput;
    let ruleOutput: StrategyOutput | null = null;

    try {
      [mlOutput, ruleOutput] = await Promise.all([
        mlStrategy.plan(input),
        ruleStrategy.plan(input).catch((err: unknown) => {
          log.warn("shadowRunner: rule strategy plan() threw, omitting baseline", {
            poolId,
            pmId,
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        }),
      ]);
    } catch (err: unknown) {
      log.warn("shadowRunner: mlStrategy.plan() threw, aborting shadow tick", {
        poolId,
        pmId,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // Snapshot the state machine context (already advanced by mlStrategy.plan()).
    const ctx = stateMachine.current();

    // Persist the shadow decision row.
    try {
      getInsert().run(
        poolId,
        pmId,
        tickMs,
        ctx.state,
        mlOutput.kind,
        serializeStrategyOutput(mlOutput),
        ruleOutput?.kind ?? null,
        ruleOutput ? serializeStrategyOutput(ruleOutput) : null,
        ctx.lendingPct,
        ctx.halfWidth,
        ctx.trendBias,
        null, // model_version: populated by a separate query against predictions if needed
        nowFn(),
      );

      log.debug("shadowRunner: shadow tick recorded", {
        poolId,
        pmId,
        mlKind: mlOutput.kind,
        ruleKind: ruleOutput?.kind ?? "n/a",
        state: ctx.state,
      });
    } catch (dbErr) {
      log.warn("shadowRunner: DB write failed", {
        poolId,
        pmId,
        error: String(dbErr),
      });
    }
  }

  return { runShadowTick };
}
