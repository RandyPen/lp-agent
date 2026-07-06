/**
 * src/services/riskObserver.ts
 *
 * Background risk observation loop that samples market data every ~30 s and
 * feeds it into the risk monitor's rolling windows.
 *
 * Purpose: the L2 circuits (checkVolatility5m, checkTvlDrop5m,
 * checkSpreadSustained) need a continuous stream of samples to build up their
 * 5-minute windows. Without this loop the windows are only populated when
 * mlAgent.plan() fires (every 20 min in NORMAL state), which starves the
 * rolling-window circuits and prevents them from detecting a crash between
 * rebalancer ticks. (G1 fix.)
 *
 * Usage (index.ts wiring):
 *   const riskObs = createRiskObserver({ poolId, marketAggregator, riskMonitor });
 *   const stopObs = riskObs.start();
 *   // On shutdown: stopObs();
 *
 * Config: RISK_OBSERVER_INTERVAL_MS env var (default 30_000 ms).
 */

import type { RiskMonitor } from "../risk/monitor.ts";
import type { MarketAggregator } from "../data/marketAggregator.ts";
import { DataOutageError } from "../data/marketAggregator.ts";
import { log } from "../lib/logger.ts";

export interface RiskObserverDeps {
  poolId: string;
  marketAggregator: MarketAggregator;
  riskMonitor: RiskMonitor;
  /** Optional shadow risk monitor to also feed. */
  shadowRiskMonitor?: RiskMonitor;
  /** Sampling interval in ms. Defaults to RISK_OBSERVER_INTERVAL_MS env var, then 30_000. */
  intervalMs?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /**
   * Optional 24h PnL fraction source (from the PnL attribution service).
   * When it returns a non-null fraction the observer feeds `set24hPnl` on
   * every sample, keeping the L2 daily-loss circuit live at observer cadence
   * (~30 s) for ALL strategies — not only on mlAgent plan ticks.
   */
  get24hPnlPct?: (poolId: string) => number | null;
}

export interface RiskObserver {
  /** Start the background loop. Returns a stop function. */
  start(): () => void;
  /**
   * Manually trigger one sample. Used by tests and the integration harness
   * to advance simulated time without real timers.
   */
  sampleOnce(): void;
}

function resolveInterval(override?: number): number {
  if (override !== undefined && override > 0) return override;
  const env = process.env.RISK_OBSERVER_INTERVAL_MS;
  if (env && env.trim() !== "") {
    const parsed = Number(env);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 30_000;
}

export function createRiskObserver(deps: RiskObserverDeps): RiskObserver {
  const { poolId, marketAggregator, riskMonitor, shadowRiskMonitor } = deps;
  const intervalMs = resolveInterval(deps.intervalMs);

  function sampleOnce(): void {
    // Feed per-source staleness FIRST — before latest() can throw. During a
    // total outage this is the only signal the monitor receives, and it is
    // exactly what lets the staleness circuits (and the L3 outage condition)
    // fire while no snapshots arrive. staleness() never throws.
    const staleness = marketAggregator.staleness();
    riskMonitor.observeSourceStaleness(poolId, staleness);
    shadowRiskMonitor?.observeSourceStaleness(poolId, staleness);

    // Feed the 24h PnL fraction when a genuine source is wired. null = no
    // data (never fabricate a value; the circuit stays honestly inert).
    if (deps.get24hPnlPct) {
      const pnlPct = deps.get24hPnlPct(poolId);
      if (pnlPct !== null) {
        riskMonitor.set24hPnl(poolId, pnlPct);
        shadowRiskMonitor?.set24hPnl(poolId, pnlPct);
      }
    }

    let snapshot;
    try {
      snapshot = marketAggregator.latest();
    } catch (err) {
      if (err instanceof DataOutageError) {
        log.warn("riskObserver: DataOutageError, skipping snapshot sample", {
          poolId,
          reason: err.message,
        });
        return;
      }
      throw err;
    }

    riskMonitor.observeForPool(poolId, snapshot);
    shadowRiskMonitor?.observeForPool(poolId, snapshot);
  }

  function start(): () => void {
    log.info("riskObserver: starting background loop", { poolId, intervalMs });
    const handle = setInterval(() => {
      try {
        sampleOnce();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("riskObserver: unhandled error in sample loop", { poolId, error: msg });
      }
    }, intervalMs);

    return () => {
      clearInterval(handle);
      log.info("riskObserver: stopped", { poolId });
    };
  }

  return { start, sampleOnce };
}
