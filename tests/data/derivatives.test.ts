/**
 * tests/data/derivatives.test.ts
 *
 * Deterministic unit tests for createDerivativesFeed.
 * All tests use an injected fake fetch — no real network calls.
 */

import { describe, it, expect } from "bun:test";
import { createDerivativesFeed } from "../../src/data/feeds/derivatives.ts";
import type { FetchFn } from "../../src/data/feeds/derivatives.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FakePremiumIndex {
  symbol: string;
  lastFundingRate: string;
  nextFundingTime: number;
  time: number;
}

interface FakeOpenInterest {
  symbol: string;
  openInterest: string;
  time: number;
}

function makeFakeFetch(funding: number, oi: number): FetchFn {
  return async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("premiumIndex")) {
      const data: FakePremiumIndex = {
        symbol: "SUIUSDT",
        lastFundingRate: String(funding),
        nextFundingTime: Date.now() + 28_800_000,
        time: Date.now(),
      };
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("openInterest")) {
      const data: FakeOpenInterest = {
        symbol: "SUIUSDT",
        openInterest: String(oi),
        time: Date.now(),
      };
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  };
}

function makeErrorFetch(): FetchFn {
  return async (): Promise<Response> =>
    new Response("internal server error", { status: 500 });
}

function makeNetworkErrorFetch(): FetchFn {
  return async (): Promise<Response> => {
    throw new Error("network down");
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createDerivativesFeed", () => {
  describe("initial state", () => {
    it("starts with funding=0, oi=0, liq1m=0", () => {
      const feed = createDerivativesFeed({ fetchFn: makeFakeFetch(0, 0) });
      const snap = feed.latest();
      expect(snap.funding).toBe(0);
      expect(snap.oi).toBe(0);
      expect(snap.liq1m).toBe(0);
    });

    it("lastUpdatedMs() is 0 before any successful poll", () => {
      const feed = createDerivativesFeed({ fetchFn: makeFakeFetch(0, 0) });
      expect(feed.lastUpdatedMs()).toBe(0);
    });
  });

  describe("successful polling", () => {
    it("populates funding and oi after start()", async () => {
      const feed = createDerivativesFeed({
        fetchFn: makeFakeFetch(0.0001, 5_000_000),
      });
      const stop = feed.start();
      await new Promise((r) => setTimeout(r, 50));
      stop();

      const snap = feed.latest();
      expect(snap.funding).toBeCloseTo(0.0001, 8);
      expect(snap.oi).toBe(5_000_000);
    });

    it("liq1m is always 0 (v1 limitation)", async () => {
      const feed = createDerivativesFeed({
        fetchFn: makeFakeFetch(0.0001, 1_000_000),
      });
      const stop = feed.start();
      await new Promise((r) => setTimeout(r, 50));
      stop();

      expect(feed.latest().liq1m).toBe(0);
    });

    it("updates lastUpdatedMs() after successful poll", async () => {
      const before = Date.now();
      const feed = createDerivativesFeed({
        fetchFn: makeFakeFetch(0.0002, 2_000_000),
      });
      const stop = feed.start();
      await new Promise((r) => setTimeout(r, 50));
      stop();

      expect(feed.lastUpdatedMs()).toBeGreaterThanOrEqual(before);
    });
  });

  describe("error handling", () => {
    it("does not throw when HTTP 500 errors occur", () => {
      const feed = createDerivativesFeed({ fetchFn: makeErrorFetch() });
      expect(() => feed.start()).not.toThrow();
      const stop = feed.start();
      stop();
    });

    it("does not throw on network errors", async () => {
      const feed = createDerivativesFeed({ fetchFn: makeNetworkErrorFetch() });
      expect(() => feed.start()).not.toThrow();
      const stop = feed.start();
      await new Promise((r) => setTimeout(r, 20));
      stop();
      // lastUpdatedMs stays 0 since all fetches failed.
      expect(feed.lastUpdatedMs()).toBe(0);
    });

    it("retains previous values when a poll cycle fails", async () => {
      // First fetch succeeds, then fails.
      let callCount = 0;
      const fetchFn: FetchFn = async (input) => {
        callCount++;
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
        if (callCount <= 2) {
          // First two calls (initial refresh): succeed
          if (url.includes("premiumIndex")) {
            return new Response(
              JSON.stringify({ symbol: "SUIUSDT", lastFundingRate: "0.0003", nextFundingTime: 0, time: 0 }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          return new Response(
            JSON.stringify({ symbol: "SUIUSDT", openInterest: "3000000", time: 0 }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        throw new Error("network failed");
      };

      const feed = createDerivativesFeed({ fetchFn });
      const stop = feed.start();
      await new Promise((r) => setTimeout(r, 50));
      stop();

      // Should have the values from the first successful refresh.
      const snap = feed.latest();
      expect(snap.funding).toBeCloseTo(0.0003, 8);
      expect(snap.oi).toBe(3_000_000);
    });
  });

  describe("stop function", () => {
    it("stop() can be called multiple times without error", () => {
      const feed = createDerivativesFeed({ fetchFn: makeFakeFetch(0, 0) });
      const stop = feed.start();
      expect(() => { stop(); stop(); }).not.toThrow();
    });
  });

  describe("snapshot values", () => {
    it("handles negative funding rate (short bias)", async () => {
      const feed = createDerivativesFeed({
        fetchFn: makeFakeFetch(-0.0002, 800_000),
      });
      const stop = feed.start();
      await new Promise((r) => setTimeout(r, 50));
      stop();

      expect(feed.latest().funding).toBeCloseTo(-0.0002, 8);
    });

    it("handles zero oi", async () => {
      const feed = createDerivativesFeed({
        fetchFn: makeFakeFetch(0.0001, 0),
      });
      const stop = feed.start();
      await new Promise((r) => setTimeout(r, 50));
      stop();

      expect(feed.latest().oi).toBe(0);
    });
  });
});
