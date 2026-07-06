/**
 * tests/services/riskObserver.test.ts
 *
 * Verifies the Phase 1 riskObserver behaviours:
 *   1. Per-source staleness is fed to the monitor BEFORE latest() can throw —
 *      a total data outage must not starve the monitor (that was the hole
 *      that let a dead feed go unnoticed between rebalancer ticks).
 *   2. The optional get24hPnlPct source feeds set24hPnl on every sample when
 *      it returns a non-null fraction, and never when null.
 */

import { describe, it, expect } from "bun:test";
import { createRiskObserver } from "../../src/services/riskObserver.ts";
import { DataOutageError } from "../../src/data/marketAggregator.ts";
import type { MarketAggregator, StalenessInfo } from "../../src/data/marketAggregator.ts";
import type { MarketSnapshot } from "../../src/prediction/types.ts";
import type { RiskMonitor, RiskVeto } from "../../src/risk/monitor.ts";

const POOL_ID = "0xpool";

function makeSnapshot(): MarketSnapshot {
  return {
    ts: 1_700_000_000_000,
    cetus: { activeBin: 100, price: "1.0", tvlUsd: 1_000_000, binStep: 10 },
    binance: { sui: [], btc: [], eth: [] },
    derivatives: { funding: 0, oi: 0, liq1m: 0 },
    spread: 0.001,
  };
}

interface SpyMonitor extends RiskMonitor {
  observed: MarketSnapshot[];
  stalenessSamples: StalenessInfo[];
  pnlValues: number[];
}

function makeSpyMonitor(): SpyMonitor {
  const observed: MarketSnapshot[] = [];
  const stalenessSamples: StalenessInfo[] = [];
  const pnlValues: number[] = [];
  return {
    observed,
    stalenessSamples,
    pnlValues,
    checkPreTick: (): RiskVeto | null => null,
    observeForPool: (_poolId, snapshot) => { observed.push(snapshot); },
    observeSourceStaleness: (_poolId, staleness) => { stalenessSamples.push(staleness); },
    set24hPnl: (_poolId, pnl) => { pnlValues.push(pnl); },
    volRecovered: () => true,
    activeLevel: () => null,
    emergencyStop: { trip: () => {}, isTripped: () => false, reset: () => {} },
  };
}

function makeAggregator(opts: { outage?: boolean; staleness?: Partial<StalenessInfo> } = {}): MarketAggregator {
  return {
    start: () => () => {},
    latest: () => {
      if (opts.outage) throw new DataOutageError(["binance", "derivatives", "cetus"]);
      return makeSnapshot();
    },
    staleness: () => ({
      sui: 0, btc: 0, eth: 0, derivatives: 0, cetus: 0,
      ...opts.staleness,
    }),
    allSourcesDown: () => opts.outage ?? false,
  };
}

describe("riskObserver.sampleOnce", () => {
  it("feeds staleness even when latest() throws DataOutageError", () => {
    const monitor = makeSpyMonitor();
    const observer = createRiskObserver({
      poolId: POOL_ID,
      marketAggregator: makeAggregator({ outage: true, staleness: { sui: 120_000, cetus: 240_000 } }),
      riskMonitor: monitor,
      intervalMs: 30_000,
    });

    observer.sampleOnce();

    expect(monitor.stalenessSamples).toHaveLength(1);
    expect(monitor.stalenessSamples[0]!.sui).toBe(120_000);
    expect(monitor.observed).toHaveLength(0); // no snapshot during outage
  });

  it("feeds both staleness and the snapshot on a healthy sample", () => {
    const monitor = makeSpyMonitor();
    const observer = createRiskObserver({
      poolId: POOL_ID,
      marketAggregator: makeAggregator(),
      riskMonitor: monitor,
      intervalMs: 30_000,
    });

    observer.sampleOnce();

    expect(monitor.stalenessSamples).toHaveLength(1);
    expect(monitor.observed).toHaveLength(1);
  });

  it("also feeds the shadow monitor when provided", () => {
    const live = makeSpyMonitor();
    const shadow = makeSpyMonitor();
    const observer = createRiskObserver({
      poolId: POOL_ID,
      marketAggregator: makeAggregator(),
      riskMonitor: live,
      shadowRiskMonitor: shadow,
      intervalMs: 30_000,
    });

    observer.sampleOnce();

    expect(live.stalenessSamples).toHaveLength(1);
    expect(shadow.stalenessSamples).toHaveLength(1);
    expect(shadow.observed).toHaveLength(1);
  });

  it("feeds set24hPnl when the source returns a fraction", () => {
    const monitor = makeSpyMonitor();
    const observer = createRiskObserver({
      poolId: POOL_ID,
      marketAggregator: makeAggregator(),
      riskMonitor: monitor,
      intervalMs: 30_000,
      get24hPnlPct: () => -0.03,
    });

    observer.sampleOnce();
    expect(monitor.pnlValues).toEqual([-0.03]);
  });

  it("does NOT feed set24hPnl when the source returns null (no fabricated 0)", () => {
    const monitor = makeSpyMonitor();
    const observer = createRiskObserver({
      poolId: POOL_ID,
      marketAggregator: makeAggregator(),
      riskMonitor: monitor,
      intervalMs: 30_000,
      get24hPnlPct: () => null,
    });

    observer.sampleOnce();
    expect(monitor.pnlValues).toHaveLength(0);
  });

  it("feeds the pnl fraction even during a data outage", () => {
    const monitor = makeSpyMonitor();
    const observer = createRiskObserver({
      poolId: POOL_ID,
      marketAggregator: makeAggregator({ outage: true }),
      riskMonitor: monitor,
      intervalMs: 30_000,
      get24hPnlPct: () => -0.08,
    });

    observer.sampleOnce();
    expect(monitor.pnlValues).toEqual([-0.08]);
  });
});
