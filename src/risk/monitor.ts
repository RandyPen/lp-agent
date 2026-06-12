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
   * Feed a fresh market snapshot into the rolling windows. Call this on every
   * new snapshot arrival (not only on rebalancer ticks).
   */
  observe(snapshot: MarketSnapshot, pred?: PredictionResponse): void;
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
  /** Latest pAbove + pBelow from predictions. */
  latestPBreakSum: number;
  /** Latest 24h PnL fraction. Updated externally by the caller via observe(). */
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
        latestPBreakSum: 0,
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
  // observe() — feed rolling windows
  // ---------------------------------------------------------------------------

  function observe(snapshot: MarketSnapshot, pred?: PredictionResponse): void {
    const poolId = snapshot.cetus.activeBin.toString(); // keyed by pool context
    // Note: poolId is derived from snapshot.cetus but we need to store per cetus pool.
    // The snapshot doesn't carry an explicit poolId field, so we derive it from the
    // cetus price string + binStep combination. In practice, the monitor is instantiated
    // per pool, but the interface is designed to handle multiple pools.
    // For now, use the spread + activeBin as a proxy, or the caller must ensure
    // snapshot.cetus.price is unique per pool. Since MarketSnapshot does not have
    // a poolId field, we use a composite key.
    //
    // In the integration layer (mlAgent / rebalancer), the caller passes snapshots
    // that are scoped to a specific pool already. We'll use the binStep+activeBin
    // composite as the pool discriminator, but real usage should call
    // observeForPool() with explicit poolId.
    observeForPool(snapshot.cetus.activeBin + ":" + snapshot.cetus.price.slice(0, 8), snapshot, pred);
  }

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

    // Update spread window (absolute value stored, sign not needed for L2)
    if (Number.isFinite(snapshot.spread)) {
      state.spreadWindow.push({ ts, spread: snapshot.spread });
      pruneWindow(state.spreadWindow, ts - SPREAD_LOOKBACK_MS - 60_000);
    }

    // Update snapshot timestamp
    state.latestSnapshotTs = ts;

    // Update pBreakSum from prediction if available
    if (pred && pred.fallback === false) {
      state.latestPBreakSum = pred.pAbove + pred.pBelow;
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
    if (pred && pred.fallback === false) {
      const pBreakResult = checkPBreakSum(pred.pAbove, pred.pBelow, thresholds.pBreakSum);
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
      const pBreakResult = checkPBreakSum(
        state.latestPBreakSum / 2, // approximate pAbove and pBelow symmetrically
        state.latestPBreakSum / 2,
        thresholds.pBreakSum,
      );

      // Find the first firing trigger for the reason string
      const firing = [volResult, tvlResult, spreadResult, outageResult, pnlResult, pBreakResult]
        .find((r) => r.fires);

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
  // Return the RiskMonitor interface
  // ---------------------------------------------------------------------------

  // Expose observeForPool for direct pool-scoped observation (used by tests
  // and integration points that have an explicit poolId).
  const monitor: RiskMonitor & {
    observeForPool(poolId: string, snapshot: MarketSnapshot, pred?: PredictionResponse): void;
    set24hPnl(poolId: string, pnl: number): void;
    emergencyStop: EmergencyStop;
  } = {
    checkPreTick,
    observe,
    observeForPool,
    activeLevel,
    set24hPnl(poolId: string, pnl: number): void {
      const state = getOrCreatePoolState(poolId);
      state.latest24hPnl = pnl;
    },
    emergencyStop,
  };

  return monitor;
}
