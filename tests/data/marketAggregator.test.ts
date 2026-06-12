/**
 * tests/data/marketAggregator.test.ts
 *
 * Tests for createMarketAggregator.
 * Uses fake feed implementations — no real feeds, no DB, no network.
 */

import { describe, it, expect } from "bun:test";
import { createMarketAggregator, DataOutageError } from "../../src/data/marketAggregator.ts";
import type { MarketAggregatorDeps } from "../../src/data/marketAggregator.ts";
import type { BinanceMultiFeed, BinanceMultiWindows } from "../../src/data/feeds/binanceMulti.ts";
import type { DerivativesFeed, DerivativesSnapshot } from "../../src/data/feeds/derivatives.ts";
import type { CetusEventsFeed, CetusPoolState } from "../../src/data/feeds/cetusEvents.ts";
import type { OhlcvBar } from "../../src/prediction/types.ts";

// ---------------------------------------------------------------------------
// Fake feed builders
// ---------------------------------------------------------------------------

function makeBar(ts: number, close: number): OhlcvBar {
  return { ts, open: close - 0.01, high: close + 0.02, low: close - 0.02, close, volume: 1000 };
}

function makeSuiBars(count: number, close: number): OhlcvBar[] {
  return Array.from({ length: count }, (_, i) => makeBar(1_700_000_000_000 + i * 60_000, close));
}

interface FakeBinanceFeedOpts {
  suiClose?: number;
  lastUpdatedMs?: number;
}

function makeFakeBinanceFeed(opts: FakeBinanceFeedOpts = {}): BinanceMultiFeed {
  const { suiClose = 2.5, lastUpdatedMs = Date.now() } = opts;
  const suiBars = makeSuiBars(5, suiClose);
  const btcBars = makeSuiBars(5, 65_000);
  const ethBars = makeSuiBars(5, 3_500);

  return {
    start: () => () => {},
    latest1m: () => ({ sui: suiBars, btc: btcBars, eth: ethBars }),
    latest5m: () => ({ sui: suiBars, btc: btcBars, eth: ethBars }),
    latest: (): BinanceMultiWindows => ({ sui: suiBars, btc: btcBars, eth: ethBars }),
    lastUpdatedMs: () => lastUpdatedMs,
  };
}

interface FakeDerivativesFeedOpts {
  funding?: number;
  oi?: number;
  liq1m?: number;
  lastUpdatedMs?: number;
}

function makeFakeDerivativesFeed(opts: FakeDerivativesFeedOpts = {}): DerivativesFeed {
  const { funding = 0.0001, oi = 5_000_000, liq1m = 0, lastUpdatedMs = Date.now() } = opts;
  const snap: DerivativesSnapshot = { funding, oi, liq1m };
  return {
    start: () => () => {},
    latest: () => snap,
    lastUpdatedMs: () => lastUpdatedMs,
  };
}

interface FakeCetusFeedOpts {
  activeBin?: number;
  price?: string;
  tvlUsd?: number;
  binStep?: number;
  lastUpdatedMs?: number;
}

function makeFakeCetusFeed(opts: FakeCetusFeedOpts = {}): CetusEventsFeed {
  const {
    activeBin = -5990,
    price = "2.50",
    tvlUsd = 500_000,
    binStep = 10,
    lastUpdatedMs = Date.now(),
  } = opts;
  const state: CetusPoolState = { activeBin, price, tvlUsd, binStep };
  return {
    start: () => () => {},
    latest: () => ({ ...state }),
    lastUpdatedMs: () => lastUpdatedMs,
  };
}

/** Helper: build a full deps object with all feeds "live". */
function makeDeps(
  binanceOpts: FakeBinanceFeedOpts = {},
  derivOpts: FakeDerivativesFeedOpts = {},
  cetusOpts: FakeCetusFeedOpts = {},
  nowMs?: number,
): MarketAggregatorDeps {
  return {
    binance: makeFakeBinanceFeed(binanceOpts),
    derivatives: makeFakeDerivativesFeed(derivOpts),
    cetus: makeFakeCetusFeed(cetusOpts),
    now: nowMs !== undefined ? () => nowMs : undefined,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createMarketAggregator", () => {
  describe("latest() — snapshot assembly", () => {
    it("assembles a valid MarketSnapshot from feed caches", () => {
      const deps = makeDeps(
        { suiClose: 2.5 },
        { funding: 0.0001, oi: 5_000_000 },
        { activeBin: -5990, price: "2.50", tvlUsd: 500_000, binStep: 10 },
      );
      const agg = createMarketAggregator(deps);
      const snap = agg.latest();

      expect(typeof snap.ts).toBe("number");
      expect(snap.ts).toBeGreaterThan(0);
      expect(snap.cetus.activeBin).toBe(-5990);
      expect(snap.cetus.price).toBe("2.50");
      expect(snap.cetus.tvlUsd).toBe(500_000);
      expect(snap.cetus.binStep).toBe(10);
      expect(snap.derivatives.funding).toBeCloseTo(0.0001, 8);
      expect(snap.derivatives.oi).toBe(5_000_000);
      expect(snap.derivatives.liq1m).toBe(0);
      expect(snap.binance.sui.length).toBe(5);
      expect(snap.binance.btc.length).toBe(5);
      expect(snap.binance.eth.length).toBe(5);
    });

    it("uses injected now() for snapshot timestamp", () => {
      const fixedNow = 1_700_000_000_000;
      const deps = makeDeps({}, {}, {}, fixedNow);
      const agg = createMarketAggregator(deps);
      const snap = agg.latest();
      expect(snap.ts).toBe(fixedNow);
    });
  });

  describe("spread calculation", () => {
    it("computes spread = (cetus_price - binance_close) / binance_close", () => {
      const binanceClose = 2.5;
      const cetusPrice = 2.51;
      const expectedSpread = (cetusPrice - binanceClose) / binanceClose;

      const deps = makeDeps(
        { suiClose: binanceClose },
        {},
        { price: String(cetusPrice) },
      );
      const agg = createMarketAggregator(deps);
      const snap = agg.latest();

      expect(snap.spread).toBeCloseTo(expectedSpread, 8);
    });

    it("spread is positive when cetus price is higher", () => {
      const deps = makeDeps(
        { suiClose: 2.5 },
        {},
        { price: "2.6" },
      );
      const snap = createMarketAggregator(deps).latest();
      expect(snap.spread).toBeGreaterThan(0);
    });

    it("spread is negative when cetus price is lower", () => {
      const deps = makeDeps(
        { suiClose: 2.5 },
        {},
        { price: "2.4" },
      );
      const snap = createMarketAggregator(deps).latest();
      expect(snap.spread).toBeLessThan(0);
    });

    it("spread is zero when prices are equal", () => {
      const deps = makeDeps(
        { suiClose: 2.5 },
        {},
        { price: "2.5" },
      );
      const snap = createMarketAggregator(deps).latest();
      expect(Math.abs(snap.spread)).toBeLessThan(1e-10);
    });

    it("spread is 0 when sui bar array is empty", () => {
      // Empty binance sui bars → latestSuiClose = 0 → spread = 0
      const binance: BinanceMultiFeed = {
        start: () => () => {},
        latest1m: () => ({ sui: [], btc: [], eth: [] }),
        latest5m: () => ({ sui: [], btc: [], eth: [] }),
        latest: () => ({ sui: [], btc: [], eth: [] }),
        lastUpdatedMs: () => Date.now(),
      };
      const deps: MarketAggregatorDeps = {
        binance,
        derivatives: makeFakeDerivativesFeed(),
        cetus: makeFakeCetusFeed({ price: "2.5" }),
      };
      const snap = createMarketAggregator(deps).latest();
      expect(snap.spread).toBe(0);
    });
  });

  describe("latest() — throws when sources are empty", () => {
    it("throws DataOutageError when binance has never updated", () => {
      const deps = makeDeps(
        { lastUpdatedMs: 0 },
        { lastUpdatedMs: Date.now() },
        { lastUpdatedMs: Date.now() },
      );
      const agg = createMarketAggregator(deps);
      expect(() => agg.latest()).toThrow(DataOutageError);
    });

    it("throws DataOutageError when derivatives has never updated", () => {
      const deps = makeDeps(
        { lastUpdatedMs: Date.now() },
        { lastUpdatedMs: 0 },
        { lastUpdatedMs: Date.now() },
      );
      const agg = createMarketAggregator(deps);
      expect(() => agg.latest()).toThrow(DataOutageError);
    });

    it("throws DataOutageError when cetus has never updated", () => {
      const deps = makeDeps(
        { lastUpdatedMs: Date.now() },
        { lastUpdatedMs: Date.now() },
        { lastUpdatedMs: 0 },
      );
      const agg = createMarketAggregator(deps);
      expect(() => agg.latest()).toThrow(DataOutageError);
    });

    it("throws DataOutageError when all sources are empty", () => {
      const deps = makeDeps(
        { lastUpdatedMs: 0 },
        { lastUpdatedMs: 0 },
        { lastUpdatedMs: 0 },
      );
      const agg = createMarketAggregator(deps);
      expect(() => agg.latest()).toThrow(DataOutageError);
    });

    it("DataOutageError includes the names of empty sources", () => {
      const deps = makeDeps(
        { lastUpdatedMs: 0 },
        { lastUpdatedMs: 0 },
        { lastUpdatedMs: Date.now() },
      );
      const agg = createMarketAggregator(deps);
      let err: unknown;
      try { agg.latest(); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(DataOutageError);
      expect((err as DataOutageError).emptySources).toContain("binance");
      expect((err as DataOutageError).emptySources).toContain("derivatives");
      expect((err as DataOutageError).emptySources).not.toContain("cetus");
    });
  });

  describe("staleness()", () => {
    it("returns Infinity for sources that have never updated", () => {
      const deps = makeDeps(
        { lastUpdatedMs: 0 },
        { lastUpdatedMs: 0 },
        { lastUpdatedMs: 0 },
        1_000_000,
      );
      const s = createMarketAggregator(deps).staleness();
      expect(s.sui).toBe(Infinity);
      expect(s.btc).toBe(Infinity);
      expect(s.eth).toBe(Infinity);
      expect(s.derivatives).toBe(Infinity);
      expect(s.cetus).toBe(Infinity);
    });

    it("returns correct age in ms for each source", () => {
      const nowMs = 1_700_000_100_000;
      const binanceUpdated = 1_700_000_090_000; // 10_000 ms ago
      const derivUpdated = 1_700_000_080_000;   // 20_000 ms ago
      const cetusUpdated = 1_700_000_095_000;   // 5_000 ms ago

      const deps = makeDeps(
        { lastUpdatedMs: binanceUpdated },
        { lastUpdatedMs: derivUpdated },
        { lastUpdatedMs: cetusUpdated },
        nowMs,
      );
      const s = createMarketAggregator(deps).staleness();

      expect(s.sui).toBe(10_000);
      expect(s.btc).toBe(10_000); // same as sui (same feed)
      expect(s.eth).toBe(10_000); // same as sui (same feed)
      expect(s.derivatives).toBe(20_000);
      expect(s.cetus).toBe(5_000);
    });
  });

  describe("allSourcesDown()", () => {
    it("returns true when ALL sources exceed maxAgeMs", () => {
      const nowMs = 1_700_000_100_000;
      const staleTs = 1_700_000_000_000; // 100_000 ms ago

      const deps = makeDeps(
        { lastUpdatedMs: staleTs },
        { lastUpdatedMs: staleTs },
        { lastUpdatedMs: staleTs },
        nowMs,
      );
      expect(createMarketAggregator(deps).allSourcesDown(50_000)).toBe(true);
    });

    it("returns false when at least one source is fresh", () => {
      const nowMs = 1_700_000_100_000;
      const staleTs = 1_700_000_000_000; // 100_000 ms ago
      const freshTs = nowMs - 10_000;    // 10_000 ms ago (fresh)

      const deps = makeDeps(
        { lastUpdatedMs: freshTs },   // fresh
        { lastUpdatedMs: staleTs },   // stale
        { lastUpdatedMs: staleTs },   // stale
        nowMs,
      );
      expect(createMarketAggregator(deps).allSourcesDown(50_000)).toBe(false);
    });

    it("returns false when all sources are fresh", () => {
      const nowMs = Date.now();
      const fresh = nowMs - 1_000;
      const deps = makeDeps(
        { lastUpdatedMs: fresh },
        { lastUpdatedMs: fresh },
        { lastUpdatedMs: fresh },
        nowMs,
      );
      expect(createMarketAggregator(deps).allSourcesDown(60_000)).toBe(false);
    });

    it("returns true when sources have never updated (lastUpdatedMs=0)", () => {
      const deps = makeDeps(
        { lastUpdatedMs: 0 },
        { lastUpdatedMs: 0 },
        { lastUpdatedMs: 0 },
        Date.now(),
      );
      expect(createMarketAggregator(deps).allSourcesDown(1)).toBe(true);
    });
  });

  describe("start() and stop()", () => {
    it("start() delegates to all feeds and returns a composite stop", () => {
      const startCalls: string[] = [];
      const stopCalls: string[] = [];

      const makeTrackedFeed = (name: string) => ({
        start: () => {
          startCalls.push(name);
          return () => { stopCalls.push(name); };
        },
        latest: () => ({ sui: [], btc: [], eth: [] }) as BinanceMultiWindows,
        latest1m: () => ({ sui: [], btc: [], eth: [] }) as BinanceMultiWindows,
        latest5m: () => ({ sui: [], btc: [], eth: [] }) as BinanceMultiWindows,
        lastUpdatedMs: () => Date.now(),
      });

      const fakeDerivatives = {
        start: () => { startCalls.push("derivatives"); return () => { stopCalls.push("derivatives"); }; },
        latest: () => ({ funding: 0, oi: 0, liq1m: 0 }),
        lastUpdatedMs: () => Date.now(),
      };

      const fakeCetus = {
        start: () => { startCalls.push("cetus"); return () => { stopCalls.push("cetus"); }; },
        latest: () => ({ activeBin: 0, price: "0", tvlUsd: 0, binStep: 10 }),
        lastUpdatedMs: () => Date.now(),
      };

      const deps: MarketAggregatorDeps = {
        binance: makeTrackedFeed("binance") as unknown as BinanceMultiFeed,
        derivatives: fakeDerivatives as unknown as DerivativesFeed,
        cetus: fakeCetus as unknown as CetusEventsFeed,
      };

      const agg = createMarketAggregator(deps);
      const stop = agg.start();

      expect(startCalls).toContain("binance");
      expect(startCalls).toContain("derivatives");
      expect(startCalls).toContain("cetus");

      stop();
      expect(stopCalls).toContain("binance");
      expect(stopCalls).toContain("derivatives");
      expect(stopCalls).toContain("cetus");
    });
  });
});
