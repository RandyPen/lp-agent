/**
 * src/risk/monitor.ts
 *
 * Risk monitor: rolling-window observation + pre-tick veto checks.
 *
 * Layer mapping (risk-monitoring-design.md §1.2 / §10.1):
 *   L1 soft circuit  — spread in [l1SpreadSoftBandLow, l1SpreadSoftBandHigh)
 *                      → reduce exposure (lendingPctBonusPp=10, halfWidthFactor=0.7)
 *   L2 hard circuit  — EXTREME triggers per §5.3 of implementation-plan-v1.md:
 *                      price volatility, TVL drop, spread sustained, pBreakSum,
 *                      24h PnL, all-source data outage, per-source staleness
 *   L3 emergency     — EmergencyStop latch; auto-tripped by evaluateL3
 *                      (repeated L2 / outage-with-position / catastrophic PnL,
 *                      thresholds in cfg.risk.l3) and by the rebalancer on
 *                      repeated tx failures; manual reset only
 *
 * Every veto is persisted to `risk_events` (pool_id, pm_id nullable, level,
 * kind, metric, threshold, observed, action) and logged via `log`.
 *
 * See docs/risk-monitoring-design.md and implementation-plan-v1.md §5.3.
 */

import type { Database } from "bun:sqlite";
import { log } from "../lib/logger.ts";
import type { L3Thresholds, RiskThresholds } from "../config.ts";
import type { MarketSnapshot, PredictionResponse } from "../prediction/types.ts";
import type { StrategyInput } from "../strategies/types.ts";
import type { StalenessInfo } from "../data/marketAggregator.ts";
import {
  checkDataOutage,
  checkPBreakSum,
  checkPnl24h,
  checkSourceStaleness,
  checkSpreadSustained,
  checkTvlDrop5m,
  checkVolatility5m,
  canExitExtreme,
  type PricePoint,
  type SourceStalenessInput,
  type SpreadPoint,
  type TvlPoint,
  type TriggerResult,
} from "./circuits.ts";
import { createEmergencyStop, type EmergencyStop } from "./emergency.ts";
import type { AlertDispatcher } from "../alerts/sinks.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RiskVeto =
  /** HALTED: nothing on-chain may run. Terminal until an operator resets. */
  | { kind: "emergency"; level: "L3"; reason: string }
  /**
   * DRAINING: L3 fired and the agent is force-exiting. The caller must bypass
   * the strategy and issue `buildExtremeWithdrawPlan` — the same action L2
   * takes — then report the outcome via `emergencyStop.recordDrainAttempt`.
   *
   * This is what stops L3 from halting with capital still deployed. It also
   * dissolves the old inverted escalation, where `evaluateL3` running before
   * the L2 branch meant that escalating from L2 to L3 CANCELLED the protective
   * withdrawal L2 was about to perform: both levels now converge on "withdraw".
   */
  | { kind: "drain"; level: "L3"; reason: string }
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
   * Feed a per-source staleness sample (from `marketAggregator.staleness()`)
   * for the pool. Unlike `observeForPool` — which requires a successful
   * `latest()` — this MUST be callable even during a data outage, so a dead
   * feed can trip the L2 circuit while no snapshots arrive. Immediately
   * re-evaluates L2 for the pool.
   */
  observeSourceStaleness(poolId: string, staleness: StalenessInfo): void;
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
  /**
   * The L3 emergency-stop latch. Exposed so the rebalancer can trip it on
   * repeated tx failures and so ops tooling gets typed access. Auto-trip
   * conditions (repeated L2, outage with open position, catastrophic PnL)
   * are evaluated inside `checkPreTick`.
   */
  readonly emergencyStop: EmergencyStop;
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
  /**
   * Epoch-ms timestamps of recent L2 EXTREME entries, pruned to the L3
   * repeated-L2 window. Feeds the L3 repeated-activation trip condition.
   */
  l2EnteredTimestamps: number[];
  /** Latest per-source staleness sample (null before first observation). */
  latestSourceStaleness: SourceStalenessInput | null;
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

/**
 * Default L3 trip thresholds — mirror the config-level defaults
 * (RISK_L3_* env vars). Deployments always pass `cfg.risk.l3`; the default
 * here exists so tests and library consumers get sane protection without
 * threading the full config.
 */
export const DEFAULT_L3_THRESHOLDS: L3Thresholds = {
  repeatedL2Count: 3,
  repeatedL2WindowMs: 3_600_000,
  outageMs: 300_000,
  pnlPct: -0.15,
  txFailureCount: 5,
  drainMaxAttempts: 3,
};

export interface RiskMonitorDeps {
  db: Database;
  thresholds: RiskThresholds;
  /** L3 emergency trip thresholds. Defaults to DEFAULT_L3_THRESHOLDS. */
  l3?: L3Thresholds;
  /** Injectable clock for deterministic tests. */
  nowMs?: () => number;
  /** Optional pre-created emergency stop. If omitted, one is created internally. */
  emergencyStop?: EmergencyStop;
  /**
   * Origin tag stamped onto every risk_events row this monitor writes.
   * The shadow risk monitor MUST pass "shadow" so live risk analytics can
   * filter on source='live' instead of relying on timestamp correlation.
   */
  source?: "live" | "shadow";
  /** Where L3 transitions are announced. Without it, they are silent. */
  alerts?: AlertDispatcher;
  /** Bounded emergency-exit attempts before going HALTED anyway. Default 3. */
  drainMaxAttempts?: number;
}

/**
 * Create the risk monitor. The returned object is stateful — it maintains
 * rolling windows per pool in memory. Inject `nowMs` for deterministic tests.
 */
export function createRiskMonitor(deps: RiskMonitorDeps): RiskMonitor {
  const { db, thresholds } = deps;
  const l3 = deps.l3 ?? DEFAULT_L3_THRESHOLDS;
  const source = deps.source ?? "live";
  const nowMs = deps.nowMs ?? (() => Date.now());
  const emergencyStop =
    deps.emergencyStop ??
    createEmergencyStop({
      db,
      nowMs,
      ...(deps.alerts ? { alerts: deps.alerts } : {}),
      ...(deps.drainMaxAttempts !== undefined ? { drainMaxAttempts: deps.drainMaxAttempts } : {}),
    });

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
      source: string,
    ]
  >(
    `INSERT INTO risk_events (pool_id, pm_id, ts_ms, level, kind, metric, threshold, observed, action, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        l2EnteredTimestamps: [],
        latestSourceStaleness: null,
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
      insertEvent.run(poolId, pmId, nowMs(), level, kind, metric, threshold, observed, action, source);
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

    // --- Data outage trigger (aggregate max-of-sources timestamp) ---
    // Only meaningful once data has flowed at least once: a cold-start monitor
    // (latestSnapshotTs === null) is "not yet warmed", not "in outage" —
    // treating it as an outage would flap EXTREME on every process start.
    // A feed that never comes up IS caught: the per-source staleness triggers
    // below fire on the real aggregator's never-updated sentinel.
    if (state.latestSnapshotTs !== null) {
      triggerResults.push(checkDataOutage(state.latestSnapshotTs, DATA_STALE_THRESHOLD_MS, now));
    }

    // --- Per-source staleness triggers ---
    // The aggregate check above is masked when any single feed stays fresh;
    // these fire when an individual source (binance-sui / cetus / derivatives)
    // goes quiet beyond its own threshold.
    triggerResults.push(...sourceStalenessResults(state, now));

    const anyFires = triggerResults.some((r) => r.fires);

    if (anyFires && !state.extremeActive) {
      // Enter EXTREME
      state.extremeActive = true;
      state.extremeEnteredAtMs = now;
      // Record the entry for the L3 repeated-L2 trip condition.
      state.l2EnteredTimestamps.push(now);
      const l2Cutoff = now - l3.repeatedL2WindowMs;
      while (state.l2EnteredTimestamps.length > 0 && state.l2EnteredTimestamps[0]! < l2Cutoff) {
        state.l2EnteredTimestamps.shift();
      }
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
        volatilityRecoveryThreshold: thresholds.volatilityRecovery,
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

  /** Per-source staleness trigger results for the pool's latest sample. */
  function sourceStalenessResults(state: PoolRiskState, now: number): TriggerResult[] {
    return checkSourceStaleness(
      state.latestSourceStaleness,
      {
        suiMs: thresholds.sourceStaleSuiMs,
        cetusMs: thresholds.sourceStaleCetusMs,
        derivMs: thresholds.sourceStaleDerivMs,
      },
      now,
    );
  }

  function observeSourceStaleness(poolId: string, staleness: StalenessInfo): void {
    const state = getOrCreatePoolState(poolId);
    state.latestSourceStaleness = {
      capturedAtMs: nowMs(),
      sui: staleness.sui,
      cetus: staleness.cetus,
      derivatives: staleness.derivatives,
    };
    // Re-evaluate L2 immediately: during a feed outage `observeForPool` never
    // fires (marketAggregator.latest() throws), so this is the only path that
    // can trip the circuit while data is missing.
    evaluateL2(poolId, state);
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

  /**
   * Evaluate the automatic L3 trip conditions for a pool. Called at the top of
   * every checkPreTick, BEFORE the isTripped() gate, so a freshly-satisfied
   * condition trips the latch and the same tick returns the emergency veto.
   *
   * Conditions (any one trips):
   *   1. Repeated L2: EXTREME entered ≥ l3.repeatedL2Count times within
   *      l3.repeatedL2WindowMs — the market (or a flapping feed) keeps
   *      breaching hard circuits; stop trusting automation.
   *   2. Data outage with an open position: no snapshot for > l3.outageMs
   *      while the PM still has liquidity deployed — we are blind AND exposed.
   *      Requires data to have flowed at least once (a never-fed monitor on a
   *      cold start must not trip).
   *   3. Catastrophic 24h PnL: latest24hPnl < l3.pnlPct (more negative than
   *      the L2 daily-loss threshold). Inert until a PnL source is wired.
   */
  function evaluateL3(input: StrategyInput, state: PoolRiskState): void {
    const poolId = input.pm.poolId;
    const pmId = input.pm.pmId;
    // Already tripped (draining or halted) for this tick's scopes — nothing to
    // re-evaluate. Checked against the SCOPES, not a global boolean, so one
    // PM's latch does not suppress evaluation for every other PM.
    if (emergencyStop.state({ poolId, pmId }) !== "ARMED") return;
    const now = nowMs();

    // 1. Repeated L2 within window
    const cutoff = now - l3.repeatedL2WindowMs;
    const recentL2 = state.l2EnteredTimestamps.filter((t) => t >= cutoff);
    if (recentL2.length >= l3.repeatedL2Count) {
      persistRiskEvent(
        poolId, pmId, "L3", "emergency_trip", "repeated_l2",
        l3.repeatedL2Count, recentL2.length, "trip_emergency_stop",
      );
      // POOL scope: repeated L2 is a property of the market, so it applies to
      // every PM on this pool.
      emergencyStop.trip(
        `repeated L2: ${recentL2.length} EXTREME activations within ${l3.repeatedL2WindowMs}ms for pool ${poolId}`,
        { kind: "pool", poolId },
      );
      return;
    }

    // 2. We cannot SEE THE POOL while a position is open.
    //
    // This used to key off `latestSnapshotTs`, which only advances when the
    // market aggregator can assemble a full snapshot — i.e. it required Binance
    // AND derivatives AND Cetus. So a Binance outage (or a geo-block, or a rate
    // limit) counted as "we are blind" and tripped L3.
    //
    // But you do not need Binance funding rates to hold or exit a DLMM
    // position. The only feed that genuinely blinds the core loop is the
    // ON-CHAIN one: `cetus.lastUpdatedMs` advances on every successful POOL
    // STATE READ (not on swaps), so its staleness means exactly "we cannot read
    // the pool". Binance and derivatives degrade the model; they do not blind
    // us to the market we are making.
    //
    // This matters more now that L3 force-exits: under the old halt-only
    // behaviour a spurious trip merely froze (position intact), whereas now it
    // would LIQUIDATE a healthy position because an external API was down.
    const cetusStaleMs = state.latestSourceStaleness?.cetus ?? null;
    if (
      cetusStaleMs !== null &&
      cetusStaleMs > l3.outageMs &&
      input.pm.positionBins.length > 0
    ) {
      persistRiskEvent(
        poolId, pmId, "L3", "emergency_trip", "pool_unreadable_with_position",
        l3.outageMs, cetusStaleMs, "trip_emergency_stop",
      );
      // POOL scope: if we cannot read the pool, every PM on it is affected.
      emergencyStop.trip(
        `cannot read pool state for ${cetusStaleMs}ms (> ${l3.outageMs}ms) with an open position on pool ${poolId}`,
        { kind: "pool", poolId },
      );
      return;
    }

    // 3. Catastrophic PnL
    if (state.latest24hPnl < l3.pnlPct) {
      persistRiskEvent(
        poolId, pmId, "L3", "emergency_trip", "pnl_catastrophic",
        l3.pnlPct, state.latest24hPnl, "trip_emergency_stop",
      );
      // POOL scope: a catastrophic loss is a property of the market.
      emergencyStop.trip(
        `24h PnL ${state.latest24hPnl} below catastrophic threshold ${l3.pnlPct} for pool ${poolId}`,
        { kind: "pool", poolId },
      );
    }
  }

  function checkPreTick(input: StrategyInput): RiskVeto | null {
    const poolId = input.pm.poolId;
    const pmId = input.pm.pmId;
    const state = getOrCreatePoolState(poolId);

    // Evaluate automatic L3 trip conditions before the latch gate — a
    // condition satisfied right now must veto this very tick.
    evaluateL3(input, state);

    // L3, highest priority. Two distinct states:
    //   HALTED   → nothing runs (terminal, needs an operator).
    //   DRAINING → force-exit the position. Removing liquidity needs no price,
    //              so this is safe to do even when the trigger was "we are blind".
    if (emergencyStop.isTripped({ poolId, pmId })) {
      return {
        kind: "emergency",
        level: "L3",
        reason: "emergency stop is active (HALTED)",
      };
    }
    if (emergencyStop.isDraining({ poolId, pmId })) {
      return {
        kind: "drain",
        level: "L3",
        reason: "L3 emergency stop: force-exiting the position before halting",
      };
    }

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
      const allTriggers = [volResult, tvlResult, spreadResult, pnlResult];
      // Cold-start guard: see evaluateL2 — never-fed ≠ outage.
      if (state.latestSnapshotTs !== null) {
        allTriggers.push(checkDataOutage(state.latestSnapshotTs, DATA_STALE_THRESHOLD_MS, now));
      }
      allTriggers.push(...sourceStalenessResults(state, now));
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
    // DRAINING is still L3 — the emergency is active, we are just exiting
    // rather than frozen. Only ARMED is "no L3".
    if (emergencyStop.state({ poolId }) !== "ARMED") return "L3";
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
    const pnlResult = checkPnl24h(state.latest24hPnl, thresholds.pnl24hPct);
    const triggerResults = [volResult, tvlResult, spreadResult, pnlResult];
    // Cold-start guard: see evaluateL2 — never-fed ≠ outage.
    if (state.latestSnapshotTs !== null) {
      triggerResults.push(checkDataOutage(state.latestSnapshotTs, DATA_STALE_THRESHOLD_MS, now));
    }
    triggerResults.push(...sourceStalenessResults(state, now));
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
      volatilityRecoveryThreshold: thresholds.volatilityRecovery,
      currentVolatility5m: volResult.observed,
    });
  }

  // ---------------------------------------------------------------------------
  // Return the RiskMonitor interface
  // ---------------------------------------------------------------------------

  const monitor: RiskMonitor = {
    checkPreTick,
    observeForPool,
    observeSourceStaleness,
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
