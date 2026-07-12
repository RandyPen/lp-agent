/**
 * Tests for SidecarPredictionProvider (W4 acceptance criteria).
 *
 * Coverage:
 *   1. Normal inference round-trip — valid 200 body → PredictionResponse with fallback=false.
 *   2. Timeout — mock fetch that never resolves → fallback="timeout".
 *   3. Connection / network error → fallback="sidecar_down".
 *   4. Non-200 HTTP status → fallback="sidecar_down".
 *   5. Malformed body (not JSON, missing keys, wrong types) → fallback="sidecar_down".
 *   6. Sidecar-reported fallback="psi" passthrough — returned as-is, not overridden.
 *   7. Sidecar-reported fallback="missing" passthrough.
 *   8. Model version switch reflected across successive responses.
 *   9. health() — ok path (status="ok" from sidecar).
 *  10. health() — sidecar returns non-200 → ok=false.
 *  11. health() — network error → ok=false, never throws.
 *  12. Integration: one Bun.serve mock sidecar — real fetch, localhost only.
 *  13. pmRangeContext derived from ctx.currentBins is included in POST body.
 *  14. pmRangeContext omitted when ctx.currentBins is empty.
 *
 * The sidecar contract is the 7-key shape (widthSigma, pAbove, pBelow,
 * modelVersion, featureCompleteness, psi, fallback); the center quantile keys
 * and their monotonicity validation were removed with the center prediction
 * head (docs/decision-remove-center-prediction.md).
 *
 * Strategy: the majority of tests use an injected `fetchImpl` (no network I/O,
 * deterministic). One integration test spins up a real `Bun.serve` on port 0
 * to exercise the full HTTP path over loopback.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { createSidecarPredictionProvider, type FetchLike } from "../../src/prediction/sidecarProvider.ts";
import type { MarketSnapshot, OhlcvBar, PmRangeContext } from "../../src/prediction/types.ts";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeBars(n: number, basePrice = 2.5): OhlcvBar[] {
  return Array.from({ length: n }, (_, i) => ({
    ts: 1_700_000_000_000 + i * 60_000,
    open: basePrice,
    high: basePrice * 1.001,
    low: basePrice * 0.999,
    close: basePrice,
    volume: 1000,
  }));
}

function makeSnapshot(): MarketSnapshot {
  return {
    ts: 1_700_001_800_000,
    cetus: { activeBin: -5990, price: "2.50", tvlUsd: 500_000, binStep: 10 },
    binance: {
      sui: makeBars(30, 2.5),
      btc: makeBars(30, 65_000),
      eth: makeBars(30, 3_500),
    },
    derivatives: { funding: 0.0001, oi: 5_000_000, liq1m: 10_000 },
    spread: 0.001,
  };
}

function makeCtx(overrides?: Partial<PmRangeContext>): PmRangeContext {
  return {
    pmId: "0xpm-test",
    activeBin: -5990,
    binStep: 10,
    currentBins: [-5992, -5991, -5990, -5989, -5988],
    ...overrides,
  };
}

/** A fully valid sidecar /predict response body (the 7-key contract). */
function validPredictBody(
  overrides?: Partial<{
    widthSigma: number;
    pAbove: number;
    pBelow: number;
    modelVersion: string;
    featureCompleteness: number;
    psi: number;
    fallback: false | "psi" | "missing" | "stale";
  }>,
) {
  return {
    widthSigma: 1.95,
    pAbove: 0.35,
    pBelow: 0.28,
    modelVersion: "v1.0.0",
    featureCompleteness: 0.92,
    psi: 0.04,
    fallback: false as false,
    ...overrides,
  };
}

/** Build a mock fetch that immediately responds with the given options. */
function makeMockFetch(opts: {
  status?: number;
  body?: unknown;
  shouldThrow?: Error;
  /**
   * If set, the mock simulates a hung connection by waiting for the AbortSignal
   * from the caller's request init. When the signal fires, the mock throws an
   * AbortError — matching real fetch behaviour.
   */
  hang?: boolean;
}): FetchLike {
  return async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (opts.shouldThrow) throw opts.shouldThrow;
    if (opts.hang) {
      // Wait until the caller's AbortSignal fires (or forever if no signal).
      await new Promise<never>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        if (signal) {
          if (signal.aborted) {
            reject(new DOMException("The operation was aborted.", "AbortError"));
            return;
          }
          signal.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }
        // Without a signal this promise never resolves — infinite hang.
      });
    }
    const status = opts.status ?? 200;
    const bodyStr = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    return new Response(bodyStr, {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
}

/** Build a mock fetch that captures the requests it received. */
function makeCapturingFetch(responses: (() => Response | Promise<Response>)[]): {
  fetchImpl: FetchLike;
  captured: { url: string; body: unknown }[];
} {
  const captured: { url: string; body: unknown }[] = [];
  let callIndex = 0;
  const fetchImpl: FetchLike = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    let parsedBody: unknown = undefined;
    if (init?.body && typeof init.body === "string") {
      try { parsedBody = JSON.parse(init.body); } catch { parsedBody = init.body; }
    }
    captured.push({ url, body: parsedBody });
    const respFn = responses[callIndex++];
    if (!respFn) throw new Error(`capturingFetch: no response configured for call ${callIndex}`);
    return respFn();
  };
  return { fetchImpl, captured };
}

// ---------------------------------------------------------------------------
// 1. Normal inference round-trip
// ---------------------------------------------------------------------------

describe("SidecarPredictionProvider: normal inference", () => {
  it("returns a PredictionResponse with fallback=false for a valid 200 body", async () => {
    const body = validPredictBody();
    const provider = createSidecarPredictionProvider({
      baseUrl: "http://127.0.0.1:9999",
      timeoutMs: 2000,
      fetchImpl: makeMockFetch({ status: 200, body }),
    });

    const resp = await provider.predict(makeSnapshot(), makeCtx());

    expect(resp.fallback).toBe(false);
    expect(resp.widthSigma).toBeCloseTo(1.95);
    expect(resp.pAbove).toBeCloseTo(0.35);
    expect(resp.pBelow).toBeCloseTo(0.28);
    expect(resp.modelVersion).toBe("v1.0.0");
    expect(resp.featureCompleteness).toBeCloseTo(0.92);
    expect(resp.psi).toBeCloseTo(0.04);
  });

  it("has name 'sidecar'", () => {
    const provider = createSidecarPredictionProvider({
      baseUrl: "http://127.0.0.1:9999",
      timeoutMs: 2000,
      fetchImpl: makeMockFetch({ status: 200, body: validPredictBody() }),
    });
    expect(provider.name).toBe("sidecar");
  });
});

// ---------------------------------------------------------------------------
// 2. Timeout
// ---------------------------------------------------------------------------

describe("SidecarPredictionProvider: timeout", () => {
  it("returns fallback='timeout' when fetch never resolves within timeoutMs", async () => {
    const provider = createSidecarPredictionProvider({
      baseUrl: "http://127.0.0.1:9999",
      timeoutMs: 50, // very short to keep the test fast
      fetchImpl: makeMockFetch({ hang: true }),
    });

    const resp = await provider.predict(makeSnapshot(), makeCtx());

    expect(resp.fallback).toBe("timeout");
    // Neutral values
    expect(resp.widthSigma).toBe(0);
    expect(resp.pAbove).toBe(0);
    expect(resp.pBelow).toBe(0);
    expect(resp.featureCompleteness).toBe(0);
    expect(resp.psi).toBe(0);
  });

  it("uses last-seen modelVersion from health() in the timeout fallback response", async () => {
    // Successful health call first → captures the version.
    let callCount = 0;
    const fetchImpl: FetchLike = async (input, init) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      if (url.endsWith("/health") && callCount === 0) {
        callCount++;
        return new Response(
          JSON.stringify({
            status: "ok",
            model_version: "v1.2.3",
            loaded_at: "2025-01-01T00:00:00Z",
            psi_summary: { max: 0.01, breached: [] },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // Subsequent predict call hangs until the signal fires.
      await new Promise<never>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        if (signal) {
          if (signal.aborted) {
            reject(new DOMException("The operation was aborted.", "AbortError"));
            return;
          }
          signal.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }
      });
      throw new Error("unreachable");
    };

    const provider = createSidecarPredictionProvider({
      baseUrl: "http://127.0.0.1:9999",
      timeoutMs: 50,
      fetchImpl,
    });

    // Warm up the model version cache.
    await provider.health();
    const resp = await provider.predict(makeSnapshot(), makeCtx());

    expect(resp.fallback).toBe("timeout");
    expect(resp.modelVersion).toBe("v1.2.3");
  });
});

// ---------------------------------------------------------------------------
// 3. Connection / network error
// ---------------------------------------------------------------------------

describe("SidecarPredictionProvider: connection error", () => {
  it("returns fallback='sidecar_down' on a network error", async () => {
    const provider = createSidecarPredictionProvider({
      baseUrl: "http://127.0.0.1:9999",
      timeoutMs: 2000,
      fetchImpl: makeMockFetch({ shouldThrow: new TypeError("fetch failed: ECONNREFUSED") }),
    });

    const resp = await provider.predict(makeSnapshot(), makeCtx());

    expect(resp.fallback).toBe("sidecar_down");
    expect(resp.widthSigma).toBe(0);
    expect(resp.pAbove).toBe(0);
    expect(resp.pBelow).toBe(0);
    expect(resp.featureCompleteness).toBe(0);
  });

  it("never throws when predict() encounters a network error", async () => {
    const provider = createSidecarPredictionProvider({
      baseUrl: "http://127.0.0.1:9999",
      timeoutMs: 2000,
      fetchImpl: makeMockFetch({ shouldThrow: new Error("EHOSTUNREACH") }),
    });

    // Must not throw — test is "did it resolve?" not "did it reject?".
    const resp = await provider.predict(makeSnapshot(), makeCtx());
    expect(resp.fallback).toBe("sidecar_down");
  });
});

// ---------------------------------------------------------------------------
// 4. Non-200 HTTP status
// ---------------------------------------------------------------------------

describe("SidecarPredictionProvider: non-200 status", () => {
  for (const status of [422, 500, 503, 404]) {
    it(`returns fallback='sidecar_down' for HTTP ${status}`, async () => {
      const provider = createSidecarPredictionProvider({
        baseUrl: "http://127.0.0.1:9999",
        timeoutMs: 2000,
        fetchImpl: makeMockFetch({ status, body: { error: "oops" } }),
      });

      const resp = await provider.predict(makeSnapshot(), makeCtx());
      expect(resp.fallback).toBe("sidecar_down");
    });
  }
});

// ---------------------------------------------------------------------------
// 5. Malformed body
// ---------------------------------------------------------------------------

describe("SidecarPredictionProvider: malformed body", () => {
  it("returns fallback='sidecar_down' for non-JSON body", async () => {
    const provider = createSidecarPredictionProvider({
      baseUrl: "http://127.0.0.1:9999",
      timeoutMs: 2000,
      fetchImpl: async () => new Response("not json", { status: 200 }),
    });

    const resp = await provider.predict(makeSnapshot(), makeCtx());
    expect(resp.fallback).toBe("sidecar_down");
  });

  it("returns fallback='sidecar_down' for a JSON object missing required keys", async () => {
    const incomplete = { widthSigma: 1.95, modelVersion: "v1.0.0" }; // missing pAbove/pBelow/… keys
    const provider = createSidecarPredictionProvider({
      baseUrl: "http://127.0.0.1:9999",
      timeoutMs: 2000,
      fetchImpl: makeMockFetch({ status: 200, body: incomplete }),
    });

    const resp = await provider.predict(makeSnapshot(), makeCtx());
    expect(resp.fallback).toBe("sidecar_down");
  });

  it("returns fallback='sidecar_down' when a numeric field is a string", async () => {
    const bad = validPredictBody({ pAbove: "one" as unknown as number });
    const provider = createSidecarPredictionProvider({
      baseUrl: "http://127.0.0.1:9999",
      timeoutMs: 2000,
      fetchImpl: makeMockFetch({ status: 200, body: bad }),
    });

    const resp = await provider.predict(makeSnapshot(), makeCtx());
    expect(resp.fallback).toBe("sidecar_down");
  });

  it("returns fallback='sidecar_down' when numeric field is NaN", async () => {
    const bad = { ...validPredictBody(), widthSigma: NaN };
    const provider = createSidecarPredictionProvider({
      baseUrl: "http://127.0.0.1:9999",
      timeoutMs: 2000,
      fetchImpl: makeMockFetch({ status: 200, body: bad }),
    });

    const resp = await provider.predict(makeSnapshot(), makeCtx());
    expect(resp.fallback).toBe("sidecar_down");
  });

  it("returns fallback='sidecar_down' when modelVersion is empty string", async () => {
    const bad = validPredictBody({ modelVersion: "" as unknown as string });
    const provider = createSidecarPredictionProvider({
      baseUrl: "http://127.0.0.1:9999",
      timeoutMs: 2000,
      fetchImpl: makeMockFetch({ status: 200, body: bad }),
    });

    const resp = await provider.predict(makeSnapshot(), makeCtx());
    expect(resp.fallback).toBe("sidecar_down");
  });

  it("returns fallback='sidecar_down' for an unrecognised fallback value", async () => {
    const bad = { ...validPredictBody(), fallback: "unknown_reason" };
    const provider = createSidecarPredictionProvider({
      baseUrl: "http://127.0.0.1:9999",
      timeoutMs: 2000,
      fetchImpl: makeMockFetch({ status: 200, body: bad }),
    });

    const resp = await provider.predict(makeSnapshot(), makeCtx());
    expect(resp.fallback).toBe("sidecar_down");
  });
});

// ---------------------------------------------------------------------------
// "quantile monotonicity" describe (q10>q50 / q50>q90 crossing → sidecar_down,
// equal quantiles accepted) removed with the center prediction head — the
// quantile keys and their monotonicity validation no longer exist
// (docs/decision-remove-center-prediction.md). Extra keys in the body are
// still tolerated (only the 7 required keys are validated):
// ---------------------------------------------------------------------------

describe("SidecarPredictionProvider: extra keys tolerated", () => {
  it("accepts a body carrying unknown extra keys (e.g. legacy center fields)", async () => {
    const withExtras = { ...validPredictBody(), centerOffset: 1, centerQ10: -2, centerQ90: 3 };
    const provider = createSidecarPredictionProvider({
      baseUrl: "http://127.0.0.1:9999",
      timeoutMs: 2000,
      fetchImpl: makeMockFetch({ status: 200, body: withExtras }),
    });

    const resp = await provider.predict(makeSnapshot(), makeCtx());
    // Extra keys are not rejected; the 7-key contract is satisfied.
    expect(resp.fallback).toBe(false);
    expect(resp.widthSigma).toBeCloseTo(1.95);
    // …and the extras are NOT propagated onto the PredictionResponse.
    expect("centerOffset" in resp).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6 & 7. Sidecar-reported fallback passthrough
// ---------------------------------------------------------------------------

describe("SidecarPredictionProvider: sidecar-side fallback passthrough", () => {
  it("passes through fallback='psi' unchanged — not overridden to 'sidecar_down'", async () => {
    const body = validPredictBody({ fallback: "psi" });
    const provider = createSidecarPredictionProvider({
      baseUrl: "http://127.0.0.1:9999",
      timeoutMs: 2000,
      fetchImpl: makeMockFetch({ status: 200, body }),
    });

    const resp = await provider.predict(makeSnapshot(), makeCtx());
    expect(resp.fallback).toBe("psi");
    // The rest of the fields are still populated (from the sidecar).
    expect(resp.modelVersion).toBe("v1.0.0");
    expect(resp.widthSigma).toBeCloseTo(1.95);
  });

  it("passes through fallback='missing' unchanged", async () => {
    const body = validPredictBody({ fallback: "missing" });
    const provider = createSidecarPredictionProvider({
      baseUrl: "http://127.0.0.1:9999",
      timeoutMs: 2000,
      fetchImpl: makeMockFetch({ status: 200, body }),
    });

    const resp = await provider.predict(makeSnapshot(), makeCtx());
    expect(resp.fallback).toBe("missing");
  });

  it("passes through fallback='stale' unchanged", async () => {
    const body = validPredictBody({ fallback: "stale" });
    const provider = createSidecarPredictionProvider({
      baseUrl: "http://127.0.0.1:9999",
      timeoutMs: 2000,
      fetchImpl: makeMockFetch({ status: 200, body }),
    });

    const resp = await provider.predict(makeSnapshot(), makeCtx());
    expect(resp.fallback).toBe("stale");
  });
});

// ---------------------------------------------------------------------------
// 9. Model version switch
// ---------------------------------------------------------------------------

describe("SidecarPredictionProvider: model version switch", () => {
  it("reflects a modelVersion change across successive predict() calls", async () => {
    let callCount = 0;
    const fetchImpl: FetchLike = async () => {
      callCount++;
      const version = callCount === 1 ? "v1.0.0" : "v1.1.0";
      return new Response(JSON.stringify(validPredictBody({ modelVersion: version })), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const provider = createSidecarPredictionProvider({
      baseUrl: "http://127.0.0.1:9999",
      timeoutMs: 2000,
      fetchImpl,
    });

    const snap = makeSnapshot();
    const ctx = makeCtx();

    const r1 = await provider.predict(snap, ctx);
    const r2 = await provider.predict(snap, ctx);

    expect(r1.modelVersion).toBe("v1.0.0");
    expect(r2.modelVersion).toBe("v1.1.0");
  });

  it("updates lastKnownModelVersion: used in fallback response after a version switch", async () => {
    let callCount = 0;
    const fetchImpl: FetchLike = async (_input) => {
      callCount++;
      if (callCount === 1) {
        // First call: successful predict with version v2.0.0.
        return new Response(JSON.stringify(validPredictBody({ modelVersion: "v2.0.0" })), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // Second call: network error → sidecar_down fallback; should carry v2.0.0.
      throw new TypeError("ECONNREFUSED");
    };

    const provider = createSidecarPredictionProvider({
      baseUrl: "http://127.0.0.1:9999",
      timeoutMs: 2000,
      fetchImpl,
    });

    const snap = makeSnapshot();
    const ctx = makeCtx();

    const r1 = await provider.predict(snap, ctx);
    expect(r1.modelVersion).toBe("v2.0.0");

    const r2 = await provider.predict(snap, ctx);
    expect(r2.fallback).toBe("sidecar_down");
    expect(r2.modelVersion).toBe("v2.0.0"); // last seen version carried over
  });
});

// ---------------------------------------------------------------------------
// 10. health() — ok path
// ---------------------------------------------------------------------------

describe("SidecarPredictionProvider: health() ok", () => {
  it("returns ok=true with modelVersion when sidecar responds with status='ok'", async () => {
    const healthBody = {
      status: "ok",
      model_version: "v1.0.0",
      loaded_at: "2025-01-01T00:00:00Z",
      psi_summary: { max: 0.02, breached: [] },
    };
    const provider = createSidecarPredictionProvider({
      baseUrl: "http://127.0.0.1:9999",
      timeoutMs: 2000,
      fetchImpl: makeMockFetch({ status: 200, body: healthBody }),
    });

    const h = await provider.health();
    expect(h.ok).toBe(true);
    expect(h.modelVersion).toBe("v1.0.0");
  });

  it("returns ok=false when sidecar status field is not 'ok'", async () => {
    const degraded = {
      status: "degraded",
      model_version: "v1.0.0",
      loaded_at: "2025-01-01T00:00:00Z",
      psi_summary: { max: 0.30, breached: ["ewma_sigma"] },
    };
    const provider = createSidecarPredictionProvider({
      baseUrl: "http://127.0.0.1:9999",
      timeoutMs: 2000,
      fetchImpl: makeMockFetch({ status: 200, body: degraded }),
    });

    const h = await provider.health();
    expect(h.ok).toBe(false);
    expect(typeof h.detail).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// 11. health() — non-200 status
// ---------------------------------------------------------------------------

describe("SidecarPredictionProvider: health() non-200", () => {
  it("returns ok=false with detail when health returns HTTP 500", async () => {
    const provider = createSidecarPredictionProvider({
      baseUrl: "http://127.0.0.1:9999",
      timeoutMs: 2000,
      fetchImpl: makeMockFetch({ status: 500, body: { error: "crash" } }),
    });

    const h = await provider.health();
    expect(h.ok).toBe(false);
    expect(h.detail).toContain("500");
  });
});

// ---------------------------------------------------------------------------
// 12. health() — network error
// ---------------------------------------------------------------------------

describe("SidecarPredictionProvider: health() network error", () => {
  it("returns ok=false and never throws on network error", async () => {
    const provider = createSidecarPredictionProvider({
      baseUrl: "http://127.0.0.1:9999",
      timeoutMs: 2000,
      fetchImpl: makeMockFetch({ shouldThrow: new TypeError("ECONNREFUSED") }),
    });

    const h = await provider.health();
    expect(h.ok).toBe(false);
    expect(typeof h.detail).toBe("string");
    expect(h.detail!.length).toBeGreaterThan(0);
  });

  it("health() timeout returns ok=false and never throws", async () => {
    const provider = createSidecarPredictionProvider({
      baseUrl: "http://127.0.0.1:9999",
      timeoutMs: 50,
      fetchImpl: makeMockFetch({ hang: true }),
    });

    const h = await provider.health();
    expect(h.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 13. Integration test — real Bun.serve loopback
// ---------------------------------------------------------------------------

describe("SidecarPredictionProvider: integration (Bun.serve loopback)", () => {
  // Spin up a minimal mock sidecar using Bun.serve on a random port.
  const mockSidecarBody = validPredictBody({ modelVersion: "v1.0.0-integration" });

  const server = Bun.serve({
    port: 0, // OS assigns a free port
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/predict" && req.method === "POST") {
        return Response.json(mockSidecarBody);
      }
      if (url.pathname === "/health" && req.method === "GET") {
        return Response.json({
          status: "ok",
          model_version: "v1.0.0-integration",
          loaded_at: "2025-01-01T00:00:00Z",
          psi_summary: { max: 0.01, breached: [] },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });

  afterAll(() => {
    server.stop(true);
  });

  it("round-trips a predict() call over localhost HTTP", async () => {
    const provider = createSidecarPredictionProvider({
      baseUrl: `http://127.0.0.1:${server.port}`,
      timeoutMs: 5000,
      // No fetchImpl injection — uses global fetch over real loopback.
    });

    const resp = await provider.predict(makeSnapshot(), makeCtx());
    expect(resp.fallback).toBe(false);
    expect(resp.modelVersion).toBe("v1.0.0-integration");
    expect(resp.widthSigma).toBeCloseTo(1.95);
  });

  it("round-trips a health() call over localhost HTTP", async () => {
    const provider = createSidecarPredictionProvider({
      baseUrl: `http://127.0.0.1:${server.port}`,
      timeoutMs: 5000,
    });

    const h = await provider.health();
    expect(h.ok).toBe(true);
    expect(h.modelVersion).toBe("v1.0.0-integration");
  });
});

// ---------------------------------------------------------------------------
// 14 & 15. pmRangeContext serialisation
// ---------------------------------------------------------------------------

describe("SidecarPredictionProvider: pmRangeContext in POST body", () => {
  it("includes pmRangeContext with lowerOffset/upperOffset when currentBins is non-empty", async () => {
    const { fetchImpl, captured } = makeCapturingFetch([
      () => Response.json(validPredictBody()),
    ]);

    const provider = createSidecarPredictionProvider({
      baseUrl: "http://127.0.0.1:9999",
      timeoutMs: 2000,
      fetchImpl,
    });

    // activeBin=-5990; currentBins spans [-5995, -5985] → offsets -5 to +5
    const ctx = makeCtx({ activeBin: -5990, currentBins: [-5995, -5990, -5985] });
    await provider.predict(makeSnapshot(), ctx);

    expect(captured).toHaveLength(1);
    const body = captured[0]!.body as Record<string, unknown>;
    expect(body).toHaveProperty("pmRangeContext");
    const prc = body["pmRangeContext"] as { lowerOffset: number; upperOffset: number };
    expect(prc.lowerOffset).toBe(-5); // min(-5995,-5990,-5985) - (-5990) = -5995+5990 = -5
    expect(prc.upperOffset).toBe(5);  // max = -5985+5990 = 5
  });

  it("omits pmRangeContext when currentBins is empty", async () => {
    const { fetchImpl, captured } = makeCapturingFetch([
      () => Response.json(validPredictBody()),
    ]);

    const provider = createSidecarPredictionProvider({
      baseUrl: "http://127.0.0.1:9999",
      timeoutMs: 2000,
      fetchImpl,
    });

    const ctx = makeCtx({ currentBins: [] });
    await provider.predict(makeSnapshot(), ctx);

    expect(captured).toHaveLength(1);
    const body = captured[0]!.body as Record<string, unknown>;
    expect(body).not.toHaveProperty("pmRangeContext");
  });
});
