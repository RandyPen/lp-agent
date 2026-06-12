/**
 * Tests for NullPredictionProvider.
 *
 * All tests are deterministic — NullProvider has no I/O and no randomness.
 * They verify:
 *   1. Output shape (required fields, correct types, invariants).
 *   2. σ → bin unit conversion sanity.
 *   3. pAbove + pBelow < 1 (by log-normal construction they are symmetric but
 *      their sum must be < 1 for any non-degenerate σ).
 *   4. Symmetric quantiles: centerQ10 = −centerQ90 when centerOffset = 0.
 *   5. health() always returns ok=true.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { createNullPredictionProvider } from "../../src/prediction/nullProvider.ts";
import type { MarketSnapshot, OhlcvBar, PmRangeContext } from "../../src/prediction/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal OhlcvBar sequence with linearly drifting close prices.
 * `basePrice` is the starting price; `nBars` bars each step by `stepFraction`.
 */
function makeBars(nBars: number, basePrice: number, stepFraction = 0): OhlcvBar[] {
  const bars: OhlcvBar[] = [];
  let p = basePrice;
  for (let i = 0; i < nBars; i++) {
    bars.push({
      ts: 1_700_000_000_000 + i * 60_000,
      open: p,
      high: p * (1 + Math.abs(stepFraction) * 0.5),
      low: p * (1 - Math.abs(stepFraction) * 0.5),
      close: p,
      volume: 1000,
    });
    p = p * (1 + stepFraction);
  }
  return bars;
}

/** Build a complete MarketSnapshot suitable for test use. */
function makeSnapshot(suiBars: OhlcvBar[], binStep = 10): MarketSnapshot {
  return {
    ts: Date.now(),
    cetus: {
      activeBin: -5990,
      price: "2.50",
      tvlUsd: 500_000,
      binStep,
    },
    binance: {
      sui: suiBars,
      btc: makeBars(30, 65_000),
      eth: makeBars(30, 3_500),
    },
    derivatives: { funding: 0.0001, oi: 5_000_000, liq1m: 10_000 },
    spread: 0.001,
  };
}

/** Build a minimal PmRangeContext. */
function makeCtx(binStep = 10): PmRangeContext {
  return {
    pmId: "0xpm-test",
    activeBin: -5990,
    binStep,
    currentBins: [-5992, -5991, -5990, -5989, -5988],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("NullPredictionProvider", () => {
  const provider = createNullPredictionProvider();

  it("has name 'null'", () => {
    expect(provider.name).toBe("null");
  });

  describe("predict() output shape", () => {
    it("returns all required fields with correct types", async () => {
      const snapshot = makeSnapshot(makeBars(30, 2.5, 0.001));
      const ctx = makeCtx();
      const resp = await provider.predict(snapshot, ctx);

      expect(typeof resp.centerOffset).toBe("number");
      expect(typeof resp.centerQ10).toBe("number");
      expect(typeof resp.centerQ90).toBe("number");
      expect(typeof resp.widthSigma).toBe("number");
      expect(typeof resp.pAbove).toBe("number");
      expect(typeof resp.pBelow).toBe("number");
      expect(typeof resp.modelVersion).toBe("string");
      expect(typeof resp.featureCompleteness).toBe("number");
      expect(typeof resp.psi).toBe("number");
      // fallback is false (not a string)
      expect(resp.fallback).toBe(false);
    });

    it("centerOffset is always 0 (no directional prediction)", async () => {
      const resp = await provider.predict(makeSnapshot(makeBars(30, 2.5, 0.002)), makeCtx());
      expect(resp.centerOffset).toBe(0);
    });

    it("modelVersion is 'null-v0'", async () => {
      const resp = await provider.predict(makeSnapshot(makeBars(10, 2.5)), makeCtx());
      expect(resp.modelVersion).toBe("null-v0");
    });

    it("featureCompleteness is 1", async () => {
      const resp = await provider.predict(makeSnapshot(makeBars(10, 2.5)), makeCtx());
      expect(resp.featureCompleteness).toBe(1);
    });

    it("psi is 0", async () => {
      const resp = await provider.predict(makeSnapshot(makeBars(10, 2.5)), makeCtx());
      expect(resp.psi).toBe(0);
    });

    it("fallback is false", async () => {
      const resp = await provider.predict(makeSnapshot(makeBars(10, 2.5)), makeCtx());
      expect(resp.fallback).toBe(false);
    });
  });

  describe("widthSigma (σ → bin conversion)", () => {
    it("is a positive finite number", async () => {
      const resp = await provider.predict(makeSnapshot(makeBars(30, 2.5, 0.001)), makeCtx());
      expect(resp.widthSigma).toBeGreaterThan(0);
      expect(Number.isFinite(resp.widthSigma)).toBe(true);
    });

    it("is at least 0.5 bins (minimum floor)", async () => {
      // Flat price history → near-zero σ, but floor should apply.
      const resp = await provider.predict(makeSnapshot(makeBars(5, 2.5, 0)), makeCtx());
      expect(resp.widthSigma).toBeGreaterThanOrEqual(0.5);
    });

    it("increases when price volatility increases (more volatile bars → wider σ)", async () => {
      const lowVol = makeBars(30, 2.5, 0.0001);  // 1 bp per bar
      const highVol = makeBars(30, 2.5, 0.01);   // 100 bp per bar
      const ctx = makeCtx();
      const respLow = await provider.predict(makeSnapshot(lowVol), ctx);
      const respHigh = await provider.predict(makeSnapshot(highVol), ctx);
      expect(respHigh.widthSigma).toBeGreaterThan(respLow.widthSigma);
    });

    it("decreases when binStep is larger (more price range per bin → fewer bins for same σ)", async () => {
      const bars = makeBars(30, 2.5, 0.005);
      // Same price history, different binStep.
      const respSmallStep = await provider.predict(makeSnapshot(bars, 10), makeCtx(10));
      const respLargeStep = await provider.predict(makeSnapshot(bars, 100), makeCtx(100));
      // Larger binStep → each bin covers more price → σ_bins is smaller.
      expect(respLargeStep.widthSigma).toBeLessThan(respSmallStep.widthSigma);
    });

    it("uses binStep from ctx when provided (ctx wins over snapshot.cetus.binStep)", async () => {
      const bars = makeBars(30, 2.5, 0.005);
      const snapshotStep10 = makeSnapshot(bars, 10);
      const ctxStep10 = makeCtx(10);
      const ctxStep20 = { ...ctxStep10, binStep: 20 };
      // ctx.binStep=20 should give a different result than ctx.binStep=10.
      const resp10 = await provider.predict(snapshotStep10, ctxStep10);
      const resp20 = await provider.predict(snapshotStep10, ctxStep20);
      // widthSigma_bins = σ_horizon × 10_000 / binStep: higher binStep → fewer bins.
      expect(resp20.widthSigma).toBeLessThan(resp10.widthSigma);
    });
  });

  describe("pAbove + pBelow invariants", () => {
    it("pAbove and pBelow are both in (0, 0.5) for typical inputs", async () => {
      const resp = await provider.predict(makeSnapshot(makeBars(30, 2.5, 0.003)), makeCtx());
      expect(resp.pAbove).toBeGreaterThan(0);
      expect(resp.pAbove).toBeLessThan(0.5);
      expect(resp.pBelow).toBeGreaterThan(0);
      expect(resp.pBelow).toBeLessThan(0.5);
    });

    it("pAbove + pBelow < 1", async () => {
      const resp = await provider.predict(makeSnapshot(makeBars(30, 2.5, 0.003)), makeCtx());
      expect(resp.pAbove + resp.pBelow).toBeLessThan(1);
    });

    it("pAbove + pBelow < 1 across a range of volatilities", async () => {
      const ctx = makeCtx();
      for (const step of [0.0001, 0.001, 0.005, 0.01, 0.05]) {
        const resp = await provider.predict(makeSnapshot(makeBars(30, 2.5, step)), ctx);
        expect(resp.pAbove + resp.pBelow).toBeLessThan(1);
      }
    });

    it("pAbove and pBelow are equal (symmetric, since centerOffset=0 and no drift)", async () => {
      const resp = await provider.predict(makeSnapshot(makeBars(30, 2.5, 0.002)), makeCtx());
      // They should be numerically identical because the log-normal is symmetric
      // around the current price under μ=0.
      expect(Math.abs(resp.pAbove - resp.pBelow)).toBeLessThan(1e-10);
    });
  });

  describe("symmetric quantiles", () => {
    it("centerQ10 = −centerQ90 (symmetric around centerOffset=0)", async () => {
      const resp = await provider.predict(makeSnapshot(makeBars(30, 2.5, 0.002)), makeCtx());
      expect(resp.centerQ90).toBe(-resp.centerQ10);
    });

    it("centerQ90 ≥ 1 (interval is at least ±1 bin)", async () => {
      const resp = await provider.predict(makeSnapshot(makeBars(30, 2.5, 0.002)), makeCtx());
      expect(resp.centerQ90).toBeGreaterThanOrEqual(1);
    });

    it("wider σ gives wider quantile interval", async () => {
      const ctx = makeCtx();
      const lowVol = await provider.predict(makeSnapshot(makeBars(30, 2.5, 0.0001)), ctx);
      const highVol = await provider.predict(makeSnapshot(makeBars(30, 2.5, 0.01)), ctx);
      expect(highVol.centerQ90).toBeGreaterThanOrEqual(lowVol.centerQ90);
    });
  });

  describe("edge cases", () => {
    it("handles empty sui bar array gracefully (produces valid output)", async () => {
      const snapshot = makeSnapshot([]);
      const resp = await provider.predict(snapshot, makeCtx());
      // Even with no bars, NullProvider falls back to MIN_SIGMA from ewmaSigma.
      expect(resp.widthSigma).toBeGreaterThan(0);
      expect(Number.isFinite(resp.widthSigma)).toBe(true);
      expect(resp.fallback).toBe(false);
    });

    it("handles a single bar gracefully", async () => {
      const resp = await provider.predict(makeSnapshot(makeBars(1, 2.5)), makeCtx());
      expect(resp.widthSigma).toBeGreaterThan(0);
      expect(resp.fallback).toBe(false);
    });

    it("is deterministic — same input produces identical output", async () => {
      const snapshot = makeSnapshot(makeBars(30, 2.5, 0.003));
      const ctx = makeCtx();
      const r1 = await provider.predict(snapshot, ctx);
      const r2 = await provider.predict(snapshot, ctx);
      expect(r1.centerOffset).toBe(r2.centerOffset);
      expect(r1.centerQ10).toBe(r2.centerQ10);
      expect(r1.centerQ90).toBe(r2.centerQ90);
      expect(r1.widthSigma).toBe(r2.widthSigma);
      expect(r1.pAbove).toBe(r2.pAbove);
      expect(r1.pBelow).toBe(r2.pBelow);
    });
  });

  describe("health()", () => {
    it("always returns ok=true", async () => {
      const health = await provider.health();
      expect(health.ok).toBe(true);
    });

    it("includes modelVersion 'null-v0'", async () => {
      const health = await provider.health();
      expect(health.modelVersion).toBe("null-v0");
    });

    it("includes a non-empty detail string", async () => {
      const health = await provider.health();
      expect(typeof health.detail).toBe("string");
      expect((health.detail ?? "").length).toBeGreaterThan(0);
    });
  });
});
