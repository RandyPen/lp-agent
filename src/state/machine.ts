/**
 * Three-state market-making state machine (NORMAL / TREND / EXTREME).
 *
 * Design: implementation-plan-v1.md §5 and decision-engine-design.md §2–§8.
 *
 * Usage:
 *   const sm = createStateMachine({ poolId: "0x...", db });
 *   const ctx = sm.advance(snapshot, pred, input, extremeSignal);
 *
 * Each `advance()` call:
 *   1. Evaluates transition predicates. Min-dwell is enforced for all
 *      NON-EMERGENCY transitions; EXTREME entry bypasses dwell (an L2 signal
 *      or p-sum spike must escalate immediately, even 1 minute after a state
 *      change). EXTREME exit respects dwell + stability + vol recovery.
 *   2. If a transition fires: closes the current DB row (sets exited_at_ms),
 *      inserts a new row, updates internal state.
 *   3. Derives continuous parameters (halfWidth, trendBias, lendingPct, …).
 *   4. Returns a fully populated StateContext (also cached for current()).
 *
 * Persistence contract:
 *   - Every state entry inserts a new row into `market_state_history` with
 *     `exited_at_ms = NULL`.
 *   - Every exit updates the previous row's `exited_at_ms`.
 *   - Pool-level: one open row per pool at a time.
 *
 * Determinism: callers inject `now?: () => number` so tests are deterministic.
 *
 * Degradation (§5.4): the machine does NOT handle fallback predictions.
 * `mlAgent` is responsible for detecting `pred.fallback !== false` and routing
 * to Tier 0 before calling `advance`.  The machine assumes `pred.fallback` is
 * `false` on every call.
 *
 * "Uncertainty high" semantics: when `pred.featureCompleteness < U_HIGH`, only
 * `maxCenterOffset` is tightened (to 1 bin).  `halfWidth`, `toleranceBins`,
 * and `lendingPct` are unaffected.  `maxCenterOffset` is not part of
 * `StateContext` (it is consumed by `diffPlanner`) — see docs.
 */

import type { Database } from "bun:sqlite";
import type {
  MarketState,
  MarketSnapshot,
  PredictionResponse,
  StateContext,
} from "../prediction/types.ts";
import type { StrategyInput } from "../strategies/types.ts";
import { log } from "../lib/logger.ts";
import {
  DEFAULT_STATE_PARAMS,
  EVAL_INTERVAL_MS,
  MIN_DWELL_MS,
  type StateParams,
  deriveHalfWidth,
  deriveLendingPct,
  deriveTrendBias,
  deriveToleranceBins,
  deriveMaxCenterOffset,
} from "./params.ts";
import {
  type ExtremeSignal,
  computeDriftStrength,
  dwellElapsed,
  shouldEnterExtreme,
  shouldEnterTrend,
  shouldExitExtreme,
  shouldExitTrend,
} from "./transitions.ts";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface StateMachine {
  /**
   * Evaluate the next state given the latest market snapshot and prediction.
   *
   * @param snapshot       Latest multi-source market snapshot.
   * @param pred           Latest prediction response (must have fallback=false).
   * @param input          Current strategy input (for pool context).
   * @param extremeSignal  Optional L2 risk signal.  null/undefined = no signal.
   * @param volRecovered   Whether the risk monitor considers volatility to have
   *                       recovered (used for EXTREME exit hysteresis).  When
   *                       omitted the machine defaults to false — the caller
   *                       (mlAgent) must supply this from riskMonitor.volRecovered().
   *                       Keeping it optional preserves backward compat for tests
   *                       that don't wire a real risk monitor.
   * @returns A fully populated StateContext for this evaluation tick.
   */
  advance(
    snapshot: MarketSnapshot,
    pred: PredictionResponse,
    input: StrategyInput,
    extremeSignal?: ExtremeSignal | null,
    volRecovered?: boolean,
  ): StateContext;

  /** Return the current StateContext without evaluating transitions. */
  current(): StateContext;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface InternalState {
  state: MarketState;
  enteredAtMs: number;
  currentRowId: number | null;
  /** State before the current one (null on first entry). */
  prevState: MarketState | null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a per-pool state machine instance.
 *
 * @param deps.poolId  Pool identifier (key for `market_state_history`).
 * @param deps.db      SQLite database (must have `market_state_history` table).
 * @param deps.now     Injectable clock.  Defaults to `() => Date.now()`.
 * @param deps.params  Threshold bundle (env-overridable via cfg.stateParams).
 *                     Defaults to DEFAULT_STATE_PARAMS.
 */
export function createStateMachine(deps: {
  poolId: string;
  db: Database;
  now?: () => number;
  params?: StateParams;
}): StateMachine {
  const { poolId, db } = deps;
  const now = deps.now ?? (() => Date.now());
  const params = deps.params ?? DEFAULT_STATE_PARAMS;

  // Prepared statements — created once, reused on every advance() call.
  const insertRow = db.prepare<
    unknown,
    [string, number, string, string, string | null]
  >(`
    INSERT INTO market_state_history
      (pool_id, entered_at_ms, state, trigger, prev_state)
    VALUES
      (?, ?, ?, ?, ?)
  `);

  const closeRow = db.prepare<unknown, [number, number]>(`
    UPDATE market_state_history
    SET    exited_at_ms = ?
    WHERE  id = ?
  `);

  // Bootstrap: start in NORMAL, enter at "now", persist the initial row.
  const bootMs = now();

  const initialRowId = (
    insertRow.run(poolId, bootMs, "NORMAL", "init", null) as { lastInsertRowid: number }
  ).lastInsertRowid;

  const internalState: InternalState = {
    state: "NORMAL",
    enteredAtMs: bootMs,
    currentRowId: initialRowId,
    prevState: null,
  };

  /** Last context produced by advance()/buildContext; null before first advance. */
  let lastCtx: StateContext | null = null;

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  function buildContext(
    state: MarketState,
    enteredAtMs: number,
    pred: PredictionResponse,
  ): StateContext {
    const trendBias =
      state === "TREND"
        ? deriveTrendBias(pred.pAbove, pred.pBelow)
        : 0;

    // L1 bonus is applied by mlAgent after the state machine returns the context;
    // deriveLendingPct no longer accepts an l1Bonus param (F6 dead-code removal).
    const lendingPct = deriveLendingPct(state, trendBias);
    const halfWidth = deriveHalfWidth(pred.widthSigma, params);
    const toleranceBins = deriveToleranceBins(pred.widthSigma, halfWidth);

    // F5: populate maxCenterOffset in the context so diffPlanner doesn't need to
    // re-derive it. The state machine owns the derivation; diffPlanner reads it.
    const uncertaintyHigh = pred.featureCompleteness < params.uHigh;
    const maxCenterOffset = deriveMaxCenterOffset(pred.widthSigma, uncertaintyHigh);

    const ctx: StateContext = {
      state,
      enteredAtMs,
      evalIntervalMs: EVAL_INTERVAL_MS[state],
      halfWidth,
      trendBias,
      strongTrend: Math.abs(trendBias) > params.trendBiasStrong,
      lendingPct,
      toleranceBins,
      maxCenterOffset,
      minDwellMs: MIN_DWELL_MS[state],
    };
    // Cache the advance()-derived context so current() reflects the real
    // derived parameters (lendingPct ramp, halfWidth, …) instead of the
    // fabricated bootstrap defaults. See current().
    lastCtx = ctx;
    return ctx;
  }

  /**
   * Perform a state transition: close the current row, insert the new row,
   * update internal state.
   */
  function transition(
    to: MarketState,
    trigger: string,
    nowMs: number,
  ): void {
    const from = internalState.state;

    // Close the current row
    if (internalState.currentRowId !== null) {
      closeRow.run(nowMs, internalState.currentRowId);
    }

    // Insert the new row
    const result = insertRow.run(
      poolId,
      nowMs,
      to,
      trigger,
      from,
    ) as { lastInsertRowid: number };

    log.info("state_machine: transition", {
      pool_id: poolId,
      from,
      to,
      trigger,
      now_ms: nowMs,
    });

    internalState.state = to;
    internalState.enteredAtMs = nowMs;
    internalState.currentRowId = result.lastInsertRowid;
    internalState.prevState = from;
  }

  // -------------------------------------------------------------------------
  // Public methods
  // -------------------------------------------------------------------------

  function advance(
    snapshot: MarketSnapshot,
    pred: PredictionResponse,
    _input: StrategyInput,
    extremeSignal?: ExtremeSignal | null,
    volRecovered = false,
  ): StateContext {
    const nowMs = now();
    const { state, enteredAtMs } = internalState;
    const dwellOk = dwellElapsed(state, enteredAtMs, nowMs);

    const uncertaintyHigh = pred.featureCompleteness < params.uHigh;

    if (uncertaintyHigh) {
      log.debug("state_machine: uncertainty high, tightening maxCenterOffset", {
        pool_id: poolId,
        featureCompleteness: pred.featureCompleteness,
      });
    }

    // EXTREME entry is an EMERGENCY transition and deliberately bypasses the
    // min-dwell gate: a flash crash or L2 circuit-breaker signal arriving 1
    // minute after entering NORMAL/TREND must still escalate immediately.
    // With dwell applied here (the pre-fix behaviour) the first 15 minutes of
    // every state entry had EXTREME effectively disabled — the rebalancer's
    // risk-bypass (G2) would run the tick, but advance() refused to escalate,
    // so the protective full-withdrawal never fired. EXTREME *exit* below
    // still respects dwell + stability + vol recovery.
    if (state !== "EXTREME") {
      const { enter, trigger } = shouldEnterExtreme(pred, extremeSignal, params);
      if (enter) {
        transition("EXTREME", trigger, nowMs);
        return buildContext("EXTREME", internalState.enteredAtMs, pred);
      }
    }

    if (dwellOk) {
      // Evaluate non-emergency transitions in priority order:
      //   NORMAL → TREND
      //   TREND → NORMAL
      //   EXTREME → (prevState or NORMAL)

      if (state === "NORMAL") {
        if (shouldEnterTrend(snapshot, pred, params)) {
          const driftStrength = computeDriftStrength(snapshot);
          const trigger = buildTrendEntryTrigger(pred, driftStrength, params);
          transition("TREND", trigger, nowMs);
          return buildContext("TREND", internalState.enteredAtMs, pred);
        }
      }

      if (state === "TREND") {
        // EXTREME escalation is handled above (before the dwell gate).
        if (shouldExitTrend(snapshot, pred, params)) {
          transition("NORMAL", "trend_exit: drift_strength and p_break both cleared", nowMs);
          return buildContext("NORMAL", internalState.enteredAtMs, pred);
        }
      }

      if (state === "EXTREME") {
        // volRecovered is supplied by the caller (mlAgent via riskMonitor.volRecovered())
        // which runs the real canExitExtreme circuit-breaker check (F2: replacing the
        // former p-sum proxy which used hardcoded literals and had no actual
        // volatility measurement).
        if (
          shouldExitExtreme(
            pred,
            extremeSignal,
            volRecovered,
            enteredAtMs,
            nowMs,
            params,
          )
        ) {
          // Return to previous state if known, otherwise NORMAL
          const returnState: MarketState =
            internalState.prevState !== null && internalState.prevState !== "EXTREME"
              ? internalState.prevState
              : "NORMAL";
          transition(
            returnState,
            "extreme_exit: all conditions cleared + stability + vol_recovery",
            nowMs,
          );
          return buildContext(returnState, internalState.enteredAtMs, pred);
        }
      }
    }

    // No transition — return the context for the current state
    return buildContext(state, enteredAtMs, pred);
  }

  function current(): StateContext {
    // Return the last advance()-derived context when available — this carries
    // the real derived parameters (lendingPct ramp, halfWidth from widthSigma)
    // instead of fabricated defaults. The state fields are refreshed from
    // internalState in case a transition happened after the cached buildContext.
    if (lastCtx !== null && lastCtx.state === internalState.state) {
      return lastCtx;
    }
    // Bootstrap (before the first advance()) or state changed without a fresh
    // buildContext (cannot happen today — every transition rebuilds ctx — but
    // guarded for safety): minimal conservative context.
    return {
      state: internalState.state,
      enteredAtMs: internalState.enteredAtMs,
      evalIntervalMs: EVAL_INTERVAL_MS[internalState.state],
      halfWidth: 2,           // minimum; real value requires widthSigma
      trendBias: 0,
      strongTrend: false,
      lendingPct: deriveLendingPct(internalState.state, 0),
      toleranceBins: 1,
      maxCenterOffset: 1,     // conservative default; real value requires featureCompleteness
      minDwellMs: MIN_DWELL_MS[internalState.state],
    };
  }

  return { advance, current };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function buildTrendEntryTrigger(
  pred: PredictionResponse,
  driftStrength: number,
  params: StateParams,
): string {
  const parts: string[] = [];
  if (driftStrength > params.driftStrengthEntry) {
    parts.push(`drift_strength=${driftStrength.toFixed(4)}>${params.driftStrengthEntry}`);
  }
  const pBreak = Math.max(pred.pAbove, pred.pBelow);
  if (pBreak > params.pBreakEntry) {
    parts.push(`p_break=${pBreak.toFixed(4)}>${params.pBreakEntry}`);
  }
  if (parts.length === 0) {
    parts.push(`drift_strength=${driftStrength.toFixed(4)}`);
  }
  return `trend_entry: ${parts.join(", ")}`;
}
