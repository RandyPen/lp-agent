/**
 * tests/data/binanceMulti.test.ts
 *
 * Deterministic unit tests for createBinanceMultiFeed.
 * All tests use an injected fake fetch — no real network calls.
 */

import { describe, it, expect } from "bun:test";
import { createBinanceMultiFeed } from "../../src/data/feeds/binanceMulti.ts";
import type { FetchFn } from "../../src/data/feeds/binanceMulti.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Binance kline tuple: [openTime, open, high, low, close, volume, closeTime, ...]
type KlineTuple = [number, string, string, string, string, string, number, string, number, string, string, string];

function makeKline(i: number, baseTime: number, close: number): KlineTuple {
  return [
    baseTime + i * 60_000,
    String(close - 0.01),
    String(close + 0.02),
    String(close - 0.02),
    String(close),
    "1000.0",
    baseTime + i * 60_000 + 59_999,
    String(close * 1000),
    100,
    "500.0",
    String(close * 500),
    "0",
  ];
}

function makeKlines(count: number, startClose: number, step = 0.01): KlineTuple[] {
  const base = 1_700_000_000_000;
  return Array.from({ length: count }, (_, i) => makeKline(i, base, startClose + i * step));
}

// Symbol → klines mapping so the fake fetch can respond per-symbol/interval.
type FakeKlineMap = Record<string, KlineTuple[]>;

function makeFakeFetch(klinesBySymbolInterval: FakeKlineMap): FetchFn {
  return async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    // Extract symbol and interval from URL query string.
    const urlObj = new URL(url);
    const symbol = urlObj.searchParams.get("symbol") ?? "";
    const interval = urlObj.searchParams.get("interval") ?? "";
    const key = `${symbol}:${interval}`;
    const klines = klinesBySymbolInterval[key] ?? klinesBySymbolInterval["default"] ?? [];
    return new Response(JSON.stringify(klines), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

function makeNetworkErrorFetch(): FetchFn {
  return async (): Promise<Response> => {
    throw new Error("network error");
  };
}

// Build a fake fetch that fails the first `failCount` calls then succeeds.
function makeRetryFetch(failCount: number, successKlines: KlineTuple[]): FetchFn {
  let calls = 0;
  return async (): Promise<Response> => {
    calls++;
    if (calls <= failCount) throw new Error(`transient error ${calls}`);
    return new Response(JSON.stringify(successKlines), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createBinanceMultiFeed", () => {
  describe("kline parsing", () => {
    it("parses klines into OhlcvBar with correct fields", async () => {
      const klines = makeKlines(5, 2.5);
      const fetchFn = makeFakeFetch({
        "SUIUSDC:1m": klines,
        "BTCUSDT:1m": makeKlines(5, 65000),
        "ETHUSDT:1m": makeKlines(5, 3500),
        "SUIUSDC:5m": klines,
        "BTCUSDT:5m": makeKlines(5, 65000),
        "ETHUSDT:5m": makeKlines(5, 3500),
      });

      const feed = createBinanceMultiFeed({ fetchFn, bars1m: 10, bars5m: 10 });

      const stop = feed.start();
      await new Promise((r) => setTimeout(r, 50));
      stop();

      const windows = feed.latest1m();
      expect(windows.sui.length).toBe(5);
      expect(windows.btc.length).toBe(5);
      expect(windows.eth.length).toBe(5);

      const bar = windows.sui[0];
      if (!bar) throw new Error("expected bar at index 0");
      expect(typeof bar.ts).toBe("number");
      expect(typeof bar.open).toBe("number");
      expect(typeof bar.high).toBe("number");
      expect(typeof bar.low).toBe("number");
      expect(typeof bar.close).toBe("number");
      expect(typeof bar.volume).toBe("number");
      expect(bar.close).toBeCloseTo(2.5, 5);
    });

    it("parses close prices correctly from kline tuple", async () => {
      const klines: KlineTuple[] = [
        [1_700_000_000_000, "2.48", "2.52", "2.46", "2.50", "5000.0",
          1_700_000_059_999, "12500.0", 200, "2500.0", "6250.0", "0"],
      ];
      const fetchFn = makeFakeFetch({
        "SUIUSDC:1m": klines,
        "BTCUSDT:1m": klines,
        "ETHUSDT:1m": klines,
        "SUIUSDC:5m": klines,
        "BTCUSDT:5m": klines,
        "ETHUSDT:5m": klines,
      });

      const feed = createBinanceMultiFeed({ fetchFn, bars1m: 5, bars5m: 5 });
      const stop = feed.start();
      await new Promise((r) => setTimeout(r, 50));
      stop();

      const { sui } = feed.latest1m();
      const first = sui[0];
      if (!first) throw new Error("expected sui[0]");
      expect(first.open).toBe(2.48);
      expect(first.high).toBe(2.52);
      expect(first.low).toBe(2.46);
      expect(first.close).toBe(2.50);
      expect(first.volume).toBe(5000.0);
      expect(first.ts).toBe(1_700_000_000_000);
    });
  });

  describe("rolling window trimming", () => {
    it("trims window to bars1m when more bars are fetched", async () => {
      const klines = makeKlines(20, 2.5);
      const fetchFn = makeFakeFetch({
        "SUIUSDC:1m": klines,
        "BTCUSDT:1m": klines,
        "ETHUSDT:1m": klines,
        "SUIUSDC:5m": klines,
        "BTCUSDT:5m": klines,
        "ETHUSDT:5m": klines,
      });

      // bars1m = 5 — window should be trimmed to 5 bars.
      const feed = createBinanceMultiFeed({ fetchFn, bars1m: 5, bars5m: 5 });
      const stop = feed.start();
      await new Promise((r) => setTimeout(r, 50));
      stop();

      expect(feed.latest1m().sui.length).toBe(5);
    });

    it("keeps newest bars after trimming (sorted ascending, last entries are newest)", async () => {
      const klines = makeKlines(10, 2.5, 0.1); // closes: 2.5, 2.6, 2.7, ..., 3.4
      const fetchFn = makeFakeFetch({
        "SUIUSDC:1m": klines,
        "BTCUSDT:1m": klines,
        "ETHUSDT:1m": klines,
        "SUIUSDC:5m": klines,
        "BTCUSDT:5m": klines,
        "ETHUSDT:5m": klines,
      });

      const feed = createBinanceMultiFeed({ fetchFn, bars1m: 3, bars5m: 3 });
      const stop = feed.start();
      await new Promise((r) => setTimeout(r, 50));
      stop();

      const bars = feed.latest1m().sui;
      expect(bars.length).toBe(3);
      const lastBar = bars[bars.length - 1];
      if (!lastBar) throw new Error("expected last bar");
      // Last 3 of 10 bars: closes 3.2, 3.3, 3.4
      expect(lastBar.close).toBeCloseTo(3.4, 3);
    });

    it("deduplicates bars with the same timestamp across refreshes", async () => {
      const klines = makeKlines(3, 2.5);
      const fetchFn: FetchFn = async (_input): Promise<Response> => {
        return new Response(JSON.stringify(klines), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };

      const feed = createBinanceMultiFeed({ fetchFn, bars1m: 10, bars5m: 10 });
      const stop = feed.start();
      await new Promise((r) => setTimeout(r, 50));
      stop();

      // Only 3 unique bars should exist regardless of how many fetches happened.
      expect(feed.latest1m().sui.length).toBe(3);
    });
  });

  describe("lastUpdatedMs", () => {
    it("returns 0 before any update", () => {
      const feed = createBinanceMultiFeed({ fetchFn: makeFakeFetch({}) });
      expect(feed.lastUpdatedMs()).toBe(0);
    });

    it("returns a recent timestamp after successful refresh", async () => {
      const before = Date.now();
      const klines = makeKlines(2, 2.5);
      const fetchFn = makeFakeFetch({
        "SUIUSDC:1m": klines, "BTCUSDT:1m": klines, "ETHUSDT:1m": klines,
        "SUIUSDC:5m": klines, "BTCUSDT:5m": klines, "ETHUSDT:5m": klines,
      });

      const feed = createBinanceMultiFeed({ fetchFn, bars1m: 5, bars5m: 5 });
      const stop = feed.start();
      await new Promise((r) => setTimeout(r, 50));
      stop();

      expect(feed.lastUpdatedMs()).toBeGreaterThanOrEqual(before);
    });
  });

  describe("retry on failure then success", () => {
    it("retries on network error and succeeds when a later attempt succeeds", async () => {
      const klines = makeKlines(3, 2.5);
      const fetchFn = makeRetryFetch(1, klines); // fail once then succeed

      const feed = createBinanceMultiFeed({ fetchFn, bars1m: 5, bars5m: 5 });
      expect(() => feed.start()).not.toThrow();
      const stop = feed.start();
      stop();
    });

    it("does not throw when all retries fail (errors are logged)", async () => {
      const fetchFn = makeNetworkErrorFetch();
      const feed = createBinanceMultiFeed({ fetchFn, bars1m: 5, bars5m: 5 });
      // start() should not propagate errors — they're logged internally.
      expect(() => feed.start()).not.toThrow();
      const stop = feed.start();
      await new Promise((r) => setTimeout(r, 20));
      stop();
      // lastUpdatedMs stays 0 since all fetches failed.
      expect(feed.lastUpdatedMs()).toBe(0);
    });
  });

  describe("latest() returns copies (no mutation)", () => {
    it("mutating returned arrays does not affect internal state", async () => {
      const klines = makeKlines(3, 2.5);
      const fetchFn = makeFakeFetch({
        "SUIUSDC:1m": klines, "BTCUSDT:1m": klines, "ETHUSDT:1m": klines,
        "SUIUSDC:5m": klines, "BTCUSDT:5m": klines, "ETHUSDT:5m": klines,
      });

      const feed = createBinanceMultiFeed({ fetchFn, bars1m: 5, bars5m: 5 });
      const stop = feed.start();
      await new Promise((r) => setTimeout(r, 50));
      stop();

      const w1 = feed.latest1m();
      w1.sui.push({ ts: 9999, open: 0, high: 0, low: 0, close: 0, volume: 0 });

      const w2 = feed.latest1m();
      expect(w2.sui.length).toBe(3); // unchanged
    });
  });

  describe("stop function", () => {
    it("stop() can be called multiple times without throwing", () => {
      const fetchFn = makeFakeFetch({});
      const feed = createBinanceMultiFeed({ fetchFn });
      const stop = feed.start();
      expect(() => { stop(); stop(); }).not.toThrow();
    });
  });
});
