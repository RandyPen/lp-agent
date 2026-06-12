/**
 * src/risk/monitor.ts
 *
 * Risk monitor: rolling-window observation + pre-tick veto checks.
 *
 * Layer mapping (risk-monitoring-design.md §一.2 / §十.1):
 *   L1 soft circuit  — spread in [l1SpreadSoftBandLow, l1SpreadSoftBandHigh)
 *                      → reduce exposure (lendingPctBonusPp=10, halfWidthFactor=0.7)
 *   L2 hard circuit  — EXTREME triggers per §5.3 of implementation-plan-v1.md:
 *                      price volatility, TVL drop, spread sustained, pBreakSum,
 *                      24h PnL, all-source data outage
 *   L3 emergency     — manual trip via EmergencyStop; checked first in checkPreTick
 *
 * Every veto is persisted to `risk_events` (pool_id, pm_id nullable, level,
 * kind, metric, threshold, observed, action) and logged via `log`.
 *
 * See docs/risk-monitoring-design.md and implementation-plan-v1.md §5.3.
 */

import type { Database } from "bun:sqlite";
import { log } from "../lib/logger.ts";
import type { RiskThresholds } from "../config.ts";
import type { MarketSnapshot, PredictionResponse } from "../prediction/types.ts";
import type { StrategyInput } from "../strategies/types.ts";
import {
  checkDataOutage,
  checkPBreakSum,
  checkPnl24h,
  checkSpreadSustained,
  checkTvlDrop5m,
  checkVolatility5m,
  canExitExtreme,
  type PricePoint,
  type SpreadPoint,
  type TvlPoint,
  type TriggerResult,
} from "./circuits.ts";
import { createEmergencyStop, type EmergencyStop } from "./emergency.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RiskVeto =
  | { kind: "emergency"; level: "L3"; reason: string }
  | { kind: "extreme"; level: "L2"; reason: string; trigger: string }
  | { kind: "soft"; level: "L1"; reason: string; lendingPctBonusPp: number; halfWidthFactor: number };

export interface RiskMonitor {
  /**
   * Called before each strategy tick. Returns a veto (L1/L2/L3) or null when
   * the tick should proceed normally.
   *
   * L3 → caller must skip all on-chain operations.
   * L2 → caller should move to EXTREME state (full withdrawal + 100% lending).
   * L1 → caller should apply soft adjustments (more lending, narrower range).
   */
  checkPreTick(input: StrategyInput): RiskVeto | null;
  /**
   * Feed a fresh market snapshot into the rolling windows for the given pool.
   * This is the primary ingestion path. Always pass an explicit poolId so that
   * per-pool windows are correctly keyed.
   *
   * Call this on every new snapshot arrival (not only on rebalancer ticks) so
   * the windows are warm before the first checkPreTick on each tick.
   */
  observeForPool(poolId: string, snapshot: MarketSnapshot, pred?: PredictionResponse): void;
  /**
   * Set the 24-hour PnL fraction for a pool. The value must be a fraction
   * (e.g. -0.05 = -5%). Only call this when a genuine PnL-pct figure is
   * available (e.g. from a PnL-attribution service); do not fabricate a value
   * by converting absolute USD PnL without a portfolio-value denominator.
   */
  set24hPnl(poolId: string, pnlFraction: number): void;
  /**
   * Returns true when the risk monitor considers volatility to have recovered
   * enough to allow an EXTREME→normal exit for the given pool.
   *
   * Equivalent to the canExitExtreme check in the monitor's evaluateL2 path:
   * all L2 triggers clear + vol below VOLATILITY_RECOVERY_THRESHOLD +
   * EXTREME_STABLE_REQUIRED_MS elapsed.
   *
   * The state machine calls this (via mlAgent) instead of computing its own
   * proxy from pred values.
   */
  volRecovered(poolId: string): boolean;
  /**
   * Return the highest active level for `poolId`, or null when no circuit is
   * currently active.
   */
  activeLevel(poolId: string): "L1" | "L2" | "L3" | null;
}

// ---------------------------------------------------------------------------
// Internal per-pool state
// ---------------------------------------------------------------------------

interface PoolRiskState {
  priceWindow: PricePoint[];
  tvlWindow: TvlPoint[];
  spreadWindow: SpreadPoint[];
  /** Latest snapshot timestamp, or null before first observation. */
  latestSnapshotTs: number | null;
  /**
   * Latest pAbove from a non-fallback prediction, stored separately so that
   * checkPreTick can call checkPBreakSum with the real values instead of
   * reconstructing them from a sum via a symmetric approximation.
   */
  latestPAbove: number;
  /** Latest pBelow from a non-fallback prediction. */
  latestPBelow: number;
  /**
   * Epoch ms of the most recent non-fallback prediction stored here.
   * Used to expire stale prediction data before running the pBreakSum
   * pre-tick check. null when no prediction has been observed yet.
   */
  latestPredTs: number | null;
  /** Latest 24h PnL fraction (caller-supplied via set24hPnl). */
  latest24hPnl: number;
  /** Whether L2 circuit is currently active for this pool. */
  extremeActive: boolean;
  /** When EXTREME was entered (epoch ms). */
  extremeEnteredAtMs: number | null;
  /** Whether L1 soft circuit is currently active. */
  softActive: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Rolling window duration: 5 minutes in ms. */
const WINDOW_5M_MS = 5 * 60 * 1000;
/** How long to look back when checking spread sustain. */
const SPREAD_LOOKBACK_MS = 2 * 60 * 1000; // 2 min, wider than 30s sustain threshold
/** Data outage threshold: 60 seconds. */
const DATA_STALE_THRESHOLD_MS = 60_000;
/** Stable period required before exiting EXTREME (10 min). */
const EXTREME_STABLE_REQUIRED_MS = 10 * 60 * 1000;
/** Volatility hysteresis: exit threshold (7%) vs entry threshold (10%). */
const VOLATILITY_RECOVERY_THRESHOLD = 0.07;
/** Max window entries to keep per pool (prune oldest when exceeded). */
const MAX_WINDOW_ENTRIES = 500;
/**
 * Maximum age of a stored prediction before the pBreakSum pre-tick check is
 * skipped. Set to 2× the NORMAL eval interval (40 min) — a prediction older
 * than this is too stale to be used as a circuit-breaker signal.
 */
const PRED_STALE_THRESHOLD_MS = 2 * 20 * 60 * 1000; // 40 min

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface RiskMonitorDeps {
  db: Database;
  thresholds: RiskThresholds;
  /** Injectable clock for deterministic tests. */
  nowMs?: () => number;
  /** Optional pre-created emergency stop. If omitted, one is created internally. */
  emergencyStop?: EmergencyStop;
}

/**
 * Create the risk monitor. The returned object is stateful — it maintains
 * rolling windows per pool in memory. Inject `nowMs` for deterministic tests.
 */
export function createRiskMonitor(deps: RiskMonitorDeps): RiskMonitor {
  const { db, thresholds } = deps;
  const nowMs = deps.nowMs ?? (() => Date.now());
  const emergencyStop = deps.emergencyStop ?? createEmergencyStop({ db, nowMs });

  // Per-pool state map: poolId → PoolRiskState
  const poolStates = new Map<string, PoolRiskState>();

  // Pre-compiled insert statement for risk_events
  const insertEvent = db.prepare<
    unknown,
    [
      pool_id: string | null,
      pm_id: string | null,
      ts_ms: number,
      level: string,
      kind: string,
      metric: string,
      threshold: number,
      observed: number,
      action: string,
    ]
  >(
    `INSERT INTO risk_events (pool_id, pm_id, ts_ms, level, kind, metric, threshold, observed, action)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  function getOrCreatePoolState(poolId: string): PoolRiskState {
    let state = poolStates.get(poolId);
    if (!state) {
      state = {
        priceWindow: [],
        tvlWindow: [],
        spreadWindow: [],
        latestSnapshotTs: null,
        latestPAbove: 0,
        latestPBelow: 0,
        latestPredTs: null,
        latest24hPnl: 0,
        extremeActive: false,
        extremeEnteredAtMs: null,
        softActive: false,
      };
      poolStates.set(poolId, state);
    }
    return state;
  }

  function pruneWindow<T extends { ts: number }>(arr: T[], cutoff: number): void {
    while (arr.length > MAX_WINDOW_ENTRIES || (arr.length > 0 && arr[0]!.ts < cutoff)) {
      arr.shift();
    }
  }

  function persistRiskEvent(
    poolId: string | null,
    pmId: string | null,
    level: "L1" | "L2" | "L3",
    kind: string,
    metric: string,
    threshold: number,
    observed: number,
    action: string,
  ): void {
    try {
      insertEvent.run(poolId, pmId, nowMs(), level, kind, metric, threshold, observed, action);
    } catch (err) {
      log.error("risk/monitor: failed to persist risk_event", {
        level,
        kind,
        metric,
        err: String(err),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // observeForPool() — feed rolling windows
  //
  // This is the sole ingestion path. Callers must always supply an explicit
  // poolId — the heuristic activeBin+price-prefix keying that `observe()` used
  // caused a memory leak (every new activeBin created a new pool entry) and
  // permanently-cold windows for the actual pool. There is no `observe()`
  // without a poolId; all callers (mlAgent, tests) use `observeForPool`.
  // ---------------------------------------------------------------------------

  function observeForPool(
    poolId: string,
    snapshot: MarketSnapshot,
    pred?: PredictionResponse,
  ): void {
    const state = getOrCreatePoolState(poolId);
    const ts = snapshot.ts;

    // Update price window
    const priceNum = parseFloat(snapshot.cetus.price);
    if (Number.isFinite(priceNum) && priceNum > 0) {
      state.priceWindow.push({ ts, price: priceNum });
      pruneWindow(state.priceWindow, ts - WINDOW_5M_MS - 60_000);
    }

    // Update TVL window
    if (Number.isFinite(snapshot.cetus.tvlUsd)) {
      state.tvlWindow.push({ ts, tvlUsd: snapshot.cetus.tvlUsd });
      pruneWindow(state.tvlWindow, ts - WINDOW_5M_MS - 60_000);
    }

    // Update spread window
    // SpreadPoint.spread stores the SIGNED spread value; consumers take abs() as needed.
    if (Number.isFinite(snapshot.spread)) {
      state.spreadWindow.push({ ts, spread: snapshot.spread });
      pruneWindow(state.spreadWindow, ts - SPREAD_LOOKBACK_MS - 60_000);
    }

    // Update snapshot timestamp
    state.latestSnapshotTs = ts;

    // Store pAbove and pBelow separately (F7) so the pre-tick check can
    // call checkPBreakSum with the real values rather than splitting a sum.
    if (pred && pred.fallback === false) {
      state.latestPAbove = pred.pAbove;
      state.latestPBelow = pred.pBelow;
      state.latestPredTs = ts;
    }

    // Evaluate L2 triggers and update extremeActive
    evaluateL2(poolId, state, pred);
    // Evaluate L1 soft band
    evaluateL1(poolId, state, snapshot.spread);
  }

  function evaluateL2(
    poolId: string,
    state: PoolRiskState,
    pred?: PredictionResponse,
  ): void {
    const now = nowMs();
    const triggerResults: TriggerResult[] = [];

    // --- Volatility trigger ---
    const volResult = checkVolatility5m(state.priceWindow, thresholds.extremeVolatility5m, now);
    triggerResults.push(volResult);

    // --- TVL drop trigger ---
    const tvlResult = checkTvlDrop5m(state.tvlWindow, thresholds.tvlDrop5m, now);
    triggerResults.push(tvlResult);

    // --- Spread sustained trigger ---
    const spreadResult = checkSpreadSustained(
      state.spreadWindow,
      thresholds.spreadExtreme,
      thresholds.spreadSustainMs,
      now,
    );
    triggerResults.push(spreadResult);

    // --- pBreakSum trigger (from prediction) ---
    // Use the freshly-passed pred when available; otherwise fall back to the
    // stored values from the most recent non-fallback observation (F7).
    if (pred && pred.fallback === false) {
      const pBreakResult = checkPBreakSum(pred.pAbove, pred.pBelow, thresholds.pBreakSum);
      triggerResults.push(pBreakResult);
    } else if (state.latestPredTs !== null) {
      const pBreakResult = checkPBreakSum(state.latestPAbove, state.latestPBelow, thresholds.pBreakSum);
      triggerResults.push(pBreakResult);
    }

    // --- 24h PnL trigger ---
    const pnlResult = checkPnl24h(state.latest24hPnl, thresholds.pnl24hPct);
    triggerResults.push(pnlResult);

    // --- Data outage trigger ---
    const outageResult = checkDataOutage(state.latestSnapshotTs, DATA_STALE_THRESHOLD_MS, now);
    triggerResults.push(outageResult);

    const anyFires = triggerResults.some((r) => r.fires);

    if (anyFires && !state.extremeActive) {
      // Enter EXTREME
      state.extremeActive = true;
      state.extremeEnteredAtMs = now;
      for (const r of triggerResults.filter((x) => x.fires)) {
        persistRiskEvent(
          poolId,
          null,
          "L2",
          "extreme_enter",
          r.metric,
          r.threshold,
          Number.isFinite(r.observed) ? r.observed : -1,
          "enter_extreme_withdraw_all",
        );
        log.warn("risk/monitor: L2 EXTREME triggered", {
          poolId,
          metric: r.metric,
          threshold: r.threshold,
          observed: r.observed,
        });
      }
    } else if (!anyFires && state.extremeActive) {
      // Check if we can exit EXTREME (hysteresis + stable period)
      const volResult5m = checkVolatility5m(state.priceWindow, thresholds.extremeVolatility5m, now);
      const canExit = canExitExtreme({
        triggerResults,
        enteredAtMs: state.extremeEnteredAtMs ?? now,
        stableRequiredMs: EXTREME_STABLE_REQUIRED_MS,
        nowMs: now,
        volatilityRecoveryThreshold: VOLATILITY_RECOVERY_THRESHOLD,
        currentVolatility5m: volResult5m.observed,
      });
      if (canExit) {
        state.extremeActive = false;
        state.extremeEnteredAtMs = null;
        persistRiskEvent(
          poolId,
          null,
          "L2",
          "extreme_exit",
          "all_triggers_clear",
          0,
          0,
          "resume_normal_operations",
        );
        log.info("risk/monitor: L2 EXTREME cleared", { poolId });
      }
    }
  }

  function evaluateL1(poolId: string, state: PoolRiskState, spread: number): void {
    const absSpread = Math.abs(spread);
    const inSoftBand =
      absSpread >= thresholds.l1SpreadSoftBandLow &&
      absSpread < thresholds.l1SpreadSoftBandHigh;

    if (inSoftBand && !state.softActive) {
      state.softActive = true;
      persistRiskEvent(
        poolId,
        null,
        "L1",
        "soft_enter",
        "spread",
        thresholds.l1SpreadSoftBandLow,
        absSpread,
        "increase_lending_narrow_width",
      );
      log.info("risk/monitor: L1 soft circuit entered", {
        poolId,
        spread: absSpread,
        band: [thresholds.l1SpreadSoftBandLow, thresholds.l1SpreadSoftBandHigh],
      });
    } else if (!inSoftBand && state.softActive) {
      state.softActive = false;
      persistRiskEvent(
        poolId,
        null,
        "L1",
        "soft_exit",
        "spread",
        thresholds.l1SpreadSoftBandLow,
        absSpread,
        "resume_normal_exposure",
      );
      log.info("risk/monitor: L1 soft circuit cleared", { poolId, spread: absSpread });
    }
  }

  // ---------------------------------------------------------------------------
  // checkPreTick()
  // ---------------------------------------------------------------------------

  function checkPreTick(input: StrategyInput): RiskVeto | null {
    // L3 check first — highest priority
    if (emergencyStop.isTripped()) {
      return {
        kind: "emergency",
        level: "L3",
        reason: "emergency stop is active",
      };
    }

    const poolId = input.pm.poolId;
    const pmId = input.pm.pmId;
    const state = getOrCreatePoolState(poolId);

    // L2 check
    if (state.extremeActive) {
      const now = nowMs();
      const volResult = checkVolatility5m(state.priceWindow, thresholds.extremeVolatility5m, now);
      const tvlResult = checkTvlDrop5m(state.tvlWindow, thresholds.tvlDrop5m, now);
      const spreadResult = checkSpreadSustained(
        state.spreadWindow,
        thresholds.spreadExtreme,
        thresholds.spreadSustainMs,
        now,
      );
      const outageResult = checkDataOutage(state.latestSnapshotTs, DATA_STALE_THRESHOLD_MS, now);
      const pnlResult = checkPnl24h(state.latest24hPnl, thresholds.pnl24hPct);
      // Only include the pBreakSum check when the stored prediction is fresh
      // enough to be meaningful (F7: skip when older than 2× NORMAL eval interval).
      const predIsFresh =
        state.latestPredTs !== null &&
        now - state.latestPredTs < PRED_STALE_THRESHOLD_MS;
      const pBreakResult = predIsFresh
        ? checkPBreakSum(state.latestPAbove, state.latestPBelow, thresholds.pBreakSum)
        : null;

      // Find the first firing trigger for the reason string
      const allTriggers = [volResult, tvlResult, spreadResult, outageResult, pnlResult];
      if (pBreakResult !== null) allTriggers.push(pBreakResult);
      const firing = allTriggers.find((r) => r.fires);

      const triggerName = firing?.metric ?? "unknown";

      // Persist veto event
      persistRiskEvent(
        poolId,
        pmId,
        "L2",
        "pre_tick_veto",
        triggerName,
        firing?.threshold ?? 0,
        Number.isFinite(firing?.observed) ? (firing?.observed ?? -1) : -1,
        "skip_tick_extreme_active",
      );

      return {
        kind: "extreme",
        level: "L2",
        reason: `L2 EXTREME active: ${triggerName}`,
        trigger: triggerName,
      };
    }

    // L1 check (only if spread data is available)
    if (state.softActive) {
      // Find the most recent spread value
      const latestSpread = state.spreadWindow.length > 0
        ? Math.abs(state.spreadWindow[state.spreadWindow.length - 1]!.spread)
        : 0;

      persistRiskEvent(
        poolId,
        pmId,
        "L1",
        "pre_tick_soft",
        "spread",
        thresholds.l1SpreadSoftBandLow,
        latestSpread,
        "apply_soft_adjustments",
      );

      return {
        kind: "soft",
        level: "L1",
        reason: `L1 soft circuit: spread ${latestSpread.toFixed(4)} in soft band`,
        lendingPctBonusPp: 10,
        halfWidthFactor: 0.7,
      };
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // activeLevel()
  // ---------------------------------------------------------------------------

  function activeLevel(poolId: string): "L1" | "L2" | "L3" | null {
    if (emergencyStop.isTripped()) return "L3";
    const state = poolStates.get(poolId);
    if (!state) return null;
    if (state.extremeActive) return "L2";
    if (state.softActive) return "L1";
    return null;
  }

  // ---------------------------------------------------------------------------
  // volRecovered() — expose the canExitExtreme check to the state machine (F2)
  // ---------------------------------------------------------------------------

  function volRecovered(poolId: string): boolean {
    const state = poolStates.get(poolId);
    if (!state || !state.extremeActive) {
      // No EXTREME state active → trivially "recovered".
      return true;
    }
    const now = nowMs();
    const volResult = checkVolatility5m(state.priceWindow, thresholds.extremeVolatility5m, now);
    // canExitExtreme also checks all L2 triggers. Re-derive the full result set here.
    const tvlResult = checkTvlDrop5m(state.tvlWindow, thresholds.tvlDrop5m, now);
    const spreadResult = checkSpreadSustained(
      state.spreadWindow,
      thresholds.spreadExtreme,
      thresholds.spreadSustainMs,
      now,
    );
    const outageResult = checkDataOutage(state.latestSnapshotTs, DATA_STALE_THRESHOLD_MS, now);
    const pnlResult = checkPnl24h(state.latest24hPnl, thresholds.pnl24hPct);
    const triggerResults = [volResult, tvlResult, spreadResult, outageResult, pnlResult];
    const predIsFresh =
      state.latestPredTs !== null &&
      now - state.latestPredTs < PRED_STALE_THRESHOLD_MS;
    if (predIsFresh) {
      triggerResults.push(checkPBreakSum(state.latestPAbove, state.latestPBelow, thresholds.pBreakSum));
    }

    return canExitExtreme({
      triggerResults,
      enteredAtMs: state.extremeEnteredAtMs ?? now,
      stableRequiredMs: EXTREME_STABLE_REQUIRED_MS,
      nowMs: now,
      volatilityRecoveryThreshold: VOLATILITY_RECOVERY_THRESHOLD,
      currentVolatility5m: volResult.observed,
    });
  }

  // ---------------------------------------------------------------------------
  // Return the RiskMonitor interface
  // ---------------------------------------------------------------------------

  const monitor: RiskMonitor & { emergencyStop: EmergencyStop } = {
    checkPreTick,
    observeForPool,
    set24hPnl(poolId: string, pnlFraction: number): void {
      const state = getOrCreatePoolState(poolId);
      state.latest24hPnl = pnlFraction;
    },
    volRecovered,
    activeLevel,
    emergencyStop,
  };

  return monitor;
}
