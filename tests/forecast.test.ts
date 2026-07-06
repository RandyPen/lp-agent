import { describe, it, expect } from "bun:test";
import {
  bucketToOhlcv,
  ewmaSigma,
  garmanKlassSigma,
  parkinsonSigma,
  scaleSigmaToHorizon,
  MIN_SIGMA,
} from "../src/forecast/volatility.ts";
import {
  computeBinWeights,
  normCdf,
  pickBinRange,
} from "../src/forecast/binWeights.ts";

describe("normCdf", () => {
  it("matches known values within A&S 7.1.26 precision (~7.5e-8)", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
    expect(normCdf(1)).toBeCloseTo(0.8413447, 5);
    expect(normCdf(-1)).toBeCloseTo(0.1586553, 5);
    expect(normCdf(1.96)).toBeCloseTo(0.975, 4);
    expect(normCdf(-1.96)).toBeCloseTo(0.025, 4);
  });

  it("is monotonic and bounded in (0, 1)", () => {
    expect(normCdf(-10)).toBeLessThan(1e-6);
    expect(normCdf(10)).toBeGreaterThan(1 - 1e-6);
    expect(normCdf(-1)).toBeLessThan(normCdf(0));
    expect(normCdf(0)).toBeLessThan(normCdf(1));
  });
});

describe("ewmaSigma", () => {
  it("returns floor when there's insufficient data", () => {
    expect(ewmaSigma([])).toBe(MIN_SIGMA);
    expect(ewmaSigma([100])).toBe(MIN_SIGMA);
  });

  it("recovers σ ≈ 0 on constant prices", () => {
    expect(ewmaSigma([100, 100, 100, 100, 100])).toBe(MIN_SIGMA);
  });

  it("scales with input variance", () => {
    const low = ewmaSigma([100, 100.1, 99.95, 100.05, 99.98]);
    const high = ewmaSigma([100, 105, 95, 110, 90]);
    expect(high).toBeGreaterThan(low);
  });

  it("rejects out-of-range lambda", () => {
    expect(() => ewmaSigma([100, 101], 0)).toThrow();
    expect(() => ewmaSigma([100, 101], 1)).toThrow();
  });
});

describe("parkinsonSigma / garmanKlassSigma", () => {
  const bars = [
    { bucketStartMs: 0, open: 100, high: 105, low: 95, close: 102 },
    { bucketStartMs: 60_000, open: 102, high: 104, low: 100, close: 103 },
    { bucketStartMs: 120_000, open: 103, high: 110, low: 98, close: 106 },
  ];

  it("Parkinson returns a positive σ for valid OHLC", () => {
    const s = parkinsonSigma(bars);
    expect(s).toBeGreaterThan(0);
    expect(Number.isFinite(s)).toBe(true);
  });

  it("Garman-Klass returns a positive σ for valid OHLC", () => {
    const s = garmanKlassSigma(bars);
    expect(s).toBeGreaterThan(0);
    expect(Number.isFinite(s)).toBe(true);
  });

  it("both estimators floor at MIN_SIGMA on empty input", () => {
    expect(parkinsonSigma([])).toBe(MIN_SIGMA);
    expect(garmanKlassSigma([])).toBe(MIN_SIGMA);
  });
});

describe("scaleSigmaToHorizon", () => {
  it("scales by sqrt of (horizon / barPeriod)", () => {
    expect(scaleSigmaToHorizon(0.01, 60_000, 60_000)).toBeCloseTo(0.01, 8);
    expect(scaleSigmaToHorizon(0.01, 60_000, 240_000)).toBeCloseTo(0.02, 6);
    expect(scaleSigmaToHorizon(0.01, 60_000, 15_000)).toBeCloseTo(0.005, 6);
  });

  it("rejects non-positive barPeriod", () => {
    expect(() => scaleSigmaToHorizon(0.01, 0, 60_000)).toThrow();
    expect(() => scaleSigmaToHorizon(0.01, -1, 60_000)).toThrow();
  });
});

describe("bucketToOhlcv", () => {
  it("buckets observations into aligned OHLC bars", () => {
    const obs = [
      { timestampMs: 1000, price: 100 },
      { timestampMs: 2500, price: 110 },
      { timestampMs: 5000, price: 95 },
      { timestampMs: 6000, price: 102 },
      { timestampMs: 9999, price: 99 },
      { timestampMs: 10_000, price: 105 },
    ];
    const bars = bucketToOhlcv(obs, 5000);
    expect(bars).toHaveLength(3);
    expect(bars[0]).toMatchObject({ bucketStartMs: 0, open: 100, high: 110, low: 100, close: 110 });
    expect(bars[1]).toMatchObject({ bucketStartMs: 5000, open: 95, high: 102, low: 95, close: 99 });
    expect(bars[2]).toMatchObject({ bucketStartMs: 10_000, open: 105, high: 105, low: 105, close: 105 });
  });

  it("handles out-of-order input", () => {
    const obs = [
      { timestampMs: 5000, price: 102 },
      { timestampMs: 1000, price: 100 },
      { timestampMs: 3000, price: 110 },
    ];
    const bars = bucketToOhlcv(obs, 5000);
    expect(bars).toHaveLength(2);
    expect(bars[0]!.open).toBe(100);
    expect(bars[0]!.high).toBe(110);
    expect(bars[1]!.open).toBe(102);
  });
});

describe("pickBinRange", () => {
  it("centers around activeBinId and respects halfWidthBins", () => {
    const r = pickBinRange(100, 3);
    expect(r.lower).toBe(97);
    expect(r.upper).toBe(103);
    expect(r.bins).toEqual([97, 98, 99, 100, 101, 102, 103]);
  });

  it("caps at maxHalfWidthBins", () => {
    const r = pickBinRange(100, 50, 10);
    expect(r.lower).toBe(90);
    expect(r.upper).toBe(110);
  });

  it("clamps halfWidth to >= 1", () => {
    const r = pickBinRange(100, 0);
    expect(r.bins).toHaveLength(3); // 99, 100, 101
  });
});

describe("computeBinWeights", () => {
  // Use a representative SUI/USDC config: binStep=10 bp, decimalsA=9, decimalsB=6.
  // logMu must be anchored at the active bin's actual log-price (otherwise
  // all bins fall outside the distribution support and we'd see the uniform
  // fallback regardless of inputs).
  const activeLogPrice = Math.log(1000); // priceFromBinId(0, 10, 9, 6) ≈ 1000
  const baseInput = {
    // Non-inverted orientation: physical decimals 9/6, human price rises with
    // bin id (same numbers the old decimalsA/decimalsB fields produced).
    orientation: { binStep: 10, poolCoinADecimals: 9, poolCoinBDecimals: 6, poolCoinAIsQuote: false },
    activeBinId: 0,
    feeRateBps: 0, // fee derate off for the base test
    distribution: { logMu: activeLogPrice, sigma: 0.01, horizonMs: 60_000, estimator: "test" },
    bins: [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5],
  };

  it("returns normalised weights that sum to 1", () => {
    const out = computeBinWeights(baseInput);
    const sum = out.bins.reduce((s, b) => s + b.weight, 0);
    expect(sum).toBeCloseTo(1, 6);
  });

  it("peaks the weight at the active bin when σ is tight", () => {
    const out = computeBinWeights({ ...baseInput, distribution: { ...baseInput.distribution, sigma: 0.0005 } });
    const active = out.bins.find((b) => b.binId === 0)!;
    const others = out.bins.filter((b) => b.binId !== 0);
    for (const o of others) {
      expect(active.weight).toBeGreaterThanOrEqual(o.weight);
    }
  });

  it("derate-zone shrinks weights near active bin when feeRateBps > 0", () => {
    const noFee = computeBinWeights(baseInput);
    const withFee = computeBinWeights({ ...baseInput, feeRateBps: 40 });
    const noFeeActive = noFee.bins.find((b) => b.binId === 0)!.weight;
    const withFeeActive = withFee.bins.find((b) => b.binId === 0)!.weight;
    expect(withFeeActive).toBeLessThan(noFeeActive);
  });

  it("falls back to uniform weights when total mass is 0", () => {
    // distribution centered far from bin range → rawMass = 0 → uniform fallback.
    const out = computeBinWeights({
      ...baseInput,
      distribution: { logMu: 100, sigma: 1e-9, horizonMs: 60_000, estimator: "test" },
    });
    const sum = out.bins.reduce((s, b) => s + b.weight, 0);
    expect(sum).toBeCloseTo(1, 6);
    const first = out.bins[0]!.weight;
    for (const b of out.bins) expect(b.weight).toBeCloseTo(first, 6);
  });
});

describe("priceFromBinId roundtrip", () => {
  it("priceFromBinId(0, ...) returns the decimal-shifted base", () => {
    // For SUI(9)/USDC(6), bin 0 → 1 × 10^(9-6) = 1000.
    expect(Number(priceFromBinIdForTest(0, 10, 9, 6))).toBeCloseTo(1000, 3);
  });

  it("priceFromBinId is monotonic in binId", () => {
    const p_neg = Number(priceFromBinIdForTest(-100, 10, 9, 6));
    const p_zero = Number(priceFromBinIdForTest(0, 10, 9, 6));
    const p_pos = Number(priceFromBinIdForTest(100, 10, 9, 6));
    expect(p_neg).toBeLessThan(p_zero);
    expect(p_zero).toBeLessThan(p_pos);
  });
});

// Local re-import (avoids polluting the binWeights namespace block above).
import { priceFromBinId as priceFromBinIdForTest } from "../src/domain/binMath.ts";
