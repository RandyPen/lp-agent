/**
 * Tests for src/decision/inventory.ts
 *
 * Coverage:
 *   - computeSuiOverage: correct signed overage calculation
 *   - classifyOverage: correct regime bucketing
 *   - computeInventoryAdjustment: correct scale factors per regime
 *   - applyInventoryScales: amounts adjusted correctly, no negatives
 *   - clampToAvailable: total never exceeds available, no negatives
 *   - Conservation: clamped totals ≤ original available (bigint-safe)
 */

import { describe, it, expect } from "bun:test";
import {
  computeSuiOverage,
  classifyOverage,
  computeInventoryAdjustment,
  applyInventoryScales,
  clampToAvailable,
  type InventoryState,
} from "../../src/decision/inventory.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInv(availableA: bigint, availableB: bigint, midPrice: number, decAdj = 1000): InventoryState {
  return { availableA, availableB, midPriceNum: midPrice, decimalAdj: decAdj };
}

// ---------------------------------------------------------------------------
// computeSuiOverage
// ---------------------------------------------------------------------------

describe("computeSuiOverage", () => {
  it("returns 0 for balanced portfolio", () => {
    // SUI value = A × price / decAdj = 1000 × 1000 / 1000 = 1000 USDC
    // USDC value = 1000 USDC
    // overage = 1000 / (1000 + 1000) - 0.5 = 0
    const inv = makeInv(1_000n, 1_000n, 1000, 1000);
    // A: 1000 raw SUI, price 1000 USDC/SUI, decAdj 1000 → value in B = 1000 * 1000 / 1000 = 1000
    // B: 1000 raw USDC
    const overage = computeSuiOverage(inv);
    expect(overage).toBeCloseTo(0, 5);
  });

  it("returns positive overage when too much coinA (SUI)", () => {
    // A: 2000 raw, B: 500 raw. SUI_value = 2000 × 1000 / 1000 = 2000, B_value = 500.
    // overage = 2000 / 2500 - 0.5 = 0.8 - 0.5 = 0.3
    const inv = makeInv(2_000n, 500n, 1000, 1000);
    const overage = computeSuiOverage(inv);
    expect(overage).toBeCloseTo(0.3, 5);
  });

  it("returns negative overage when too much coinB (USDC)", () => {
    const inv = makeInv(500n, 2_000n, 1000, 1000);
    // SUI_value = 500, B_value = 2000, total = 2500
    // overage = 500/2500 - 0.5 = 0.2 - 0.5 = -0.3
    const overage = computeSuiOverage(inv);
    expect(overage).toBeCloseTo(-0.3, 5);
  });

  it("returns 0 for zero available", () => {
    const inv = makeInv(0n, 0n, 1000, 1000);
    expect(computeSuiOverage(inv)).toBe(0);
  });

  it("returns 0 for non-positive price", () => {
    const inv = makeInv(1000n, 1000n, 0, 1000);
    expect(computeSuiOverage(inv)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// classifyOverage
// ---------------------------------------------------------------------------

describe("classifyOverage", () => {
  it("balanced for |overage| < 0.15", () => {
    expect(classifyOverage(0)).toBe("balanced");
    expect(classifyOverage(0.14)).toBe("balanced");
    expect(classifyOverage(-0.14)).toBe("balanced");
  });

  it("mild for 0.15 ≤ |overage| < 0.30", () => {
    expect(classifyOverage(0.15)).toBe("mild");
    expect(classifyOverage(0.29)).toBe("mild");
    expect(classifyOverage(-0.2)).toBe("mild");
  });

  it("moderate for 0.30 ≤ |overage| < 0.50", () => {
    expect(classifyOverage(0.30)).toBe("moderate");
    expect(classifyOverage(0.49)).toBe("moderate");
    expect(classifyOverage(-0.35)).toBe("moderate");
  });

  it("severe for |overage| ≥ 0.50", () => {
    expect(classifyOverage(0.50)).toBe("severe");
    expect(classifyOverage(0.99)).toBe("severe");
    expect(classifyOverage(-0.60)).toBe("severe");
  });
});

// ---------------------------------------------------------------------------
// computeInventoryAdjustment
// ---------------------------------------------------------------------------

describe("computeInventoryAdjustment", () => {
  it("balanced: both scales = 1, no bypass", () => {
    const inv = makeInv(1_000n, 1_000n, 1000, 1000);
    const adj = computeInventoryAdjustment(inv);
    expect(adj.regime).toBe("balanced");
    expect(adj.bidScale).toBe(1);
    expect(adj.askScale).toBe(1);
    expect(adj.singleSidedOnly).toBe(false);
    expect(adj.bypassGasFilter).toBe(false);
  });

  it("mild SUI overage: bid scale 0.7, ask scale 1.5", () => {
    // overage ≈ 0.3 → mild territory — but we need exactly mild not moderate
    // SUI_value = 1750, B_value = 500 → overage = 1750/2250 - 0.5 = 0.278 → mild
    const inv = makeInv(1_750n, 500n, 1000, 1000);
    const adj = computeInventoryAdjustment(inv);
    expect(adj.regime).toBe("mild");
    expect(adj.bidScale).toBeCloseTo(0.7, 5);  // too much SUI → reduce bid (SUI)
    expect(adj.askScale).toBeCloseTo(1.5, 5);   // too little USDC → boost ask (USDC)
  });

  it("mild USDC overage: bid scale 1.5, ask scale 0.7", () => {
    const inv = makeInv(500n, 1_750n, 1000, 1000);
    const adj = computeInventoryAdjustment(inv);
    expect(adj.regime).toBe("mild");
    expect(adj.bidScale).toBeCloseTo(1.5, 5);
    expect(adj.askScale).toBeCloseTo(0.7, 5);
  });

  it("moderate SUI overage: bid scale 0 (stop bid orders)", () => {
    // SUI_value = 4000, B_value = 500 → overage = 4000/4500 - 0.5 = 0.389 → moderate
    const inv = makeInv(4_000n, 500n, 1000, 1000);
    const adj = computeInventoryAdjustment(inv);
    expect(adj.regime).toBe("moderate");
    expect(adj.bidScale).toBe(0); // stop bid orders (too much SUI)
    expect(adj.askScale).toBe(1);
  });

  it("severe SUI overage: single-sided, bypass gas filter", () => {
    // SUI_value = 9000 × 1000 / 1000 = 9000, B_value = 0 → overage = 9000/9000 - 0.5 = 0.5 → severe
    const inv = makeInv(9_000n, 0n, 1000, 1000);
    const adj = computeInventoryAdjustment(inv);
    expect(adj.regime).toBe("severe");
    expect(adj.bidScale).toBe(0);
    expect(adj.askScale).toBe(1);
    expect(adj.singleSidedOnly).toBe(true);
    expect(adj.bypassGasFilter).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// applyInventoryScales
// ---------------------------------------------------------------------------

describe("applyInventoryScales", () => {
  it("no-op for balanced adjustment (scale = 1)", () => {
    const bins = [-2, -1, 1, 2];
    const amountsA = [100n, 200n, 0n, 0n];
    const amountsB = [0n, 0n, 150n, 100n];
    const adj = {
      bidScale: 1,
      askScale: 1,
      regime: "balanced" as const,
      suiOverage: 0,
      singleSidedOnly: false,
      bypassGasFilter: false,
    };
    const { adjustedA, adjustedB } = applyInventoryScales(bins, amountsA, amountsB, 0, adj);
    expect(adjustedA).toEqual([100n, 200n, 0n, 0n]);
    expect(adjustedB).toEqual([0n, 0n, 150n, 100n]);
  });

  it("reduces coinA amounts and increases coinB amounts for coinA overage", () => {
    // Physical side rule: coinA lives in bins ABOVE active, coinB below.
    const bins = [-2, -1, 1, 2];
    const amountsA = [0n, 0n, 200n, 200n];
    const amountsB = [200n, 200n, 0n, 0n];
    const adj = {
      bidScale: 0.7,
      askScale: 1.5,
      regime: "mild" as const,
      suiOverage: 0.2,
      singleSidedOnly: false,
      bypassGasFilter: false,
    };
    const { adjustedA, adjustedB } = applyInventoryScales(bins, amountsA, amountsB, 0, adj);
    // coinA (above active): 200 × 0.7 = 140
    expect(adjustedA[2]).toBe(140n);
    expect(adjustedA[3]).toBe(140n);
    // coinB (below active): 200 × 1.5 = 300
    expect(adjustedB[0]).toBe(300n);
    expect(adjustedB[1]).toBe(300n);
  });

  it("zeroes coinA amounts for moderate/severe coinA overage", () => {
    // Physical side rule: coinA above active, coinB below.
    const bins = [-1, 1];
    const amountsA = [0n, 500n];
    const amountsB = [500n, 0n];
    const adj = {
      bidScale: 0,
      askScale: 1,
      regime: "moderate" as const,
      suiOverage: 0.4,
      singleSidedOnly: false,
      bypassGasFilter: false,
    };
    const { adjustedA, adjustedB } = applyInventoryScales(bins, amountsA, amountsB, 0, adj);
    expect(adjustedA[1]).toBe(0n);
    expect(adjustedB[0]).toBe(500n);
  });

  it("throws on length mismatch", () => {
    const adj = {
      bidScale: 1, askScale: 1, regime: "balanced" as const,
      suiOverage: 0, singleSidedOnly: false, bypassGasFilter: false,
    };
    expect(() => applyInventoryScales([1], [100n, 200n], [0n], 0, adj)).toThrow();
  });

  it("no negative values in output", () => {
    const bins = [-2, 2];
    const amountsA = [100n, 0n];
    const amountsB = [0n, 100n];
    const adj = {
      bidScale: 0,
      askScale: 0,
      regime: "severe" as const,
      suiOverage: 0,
      singleSidedOnly: true,
      bypassGasFilter: true,
    };
    const { adjustedA, adjustedB } = applyInventoryScales(bins, amountsA, amountsB, 0, adj);
    for (const a of adjustedA) expect(a).toBeGreaterThanOrEqual(0n);
    for (const b of adjustedB) expect(b).toBeGreaterThanOrEqual(0n);
  });
});

// ---------------------------------------------------------------------------
// clampToAvailable
// ---------------------------------------------------------------------------

describe("clampToAvailable", () => {
  it("no clamping when total < available", () => {
    const amountsA = [100n, 200n];
    const amountsB = [150n, 100n];
    const { clampedA, clampedB } = clampToAvailable(amountsA, amountsB, 1000n, 1000n);
    expect(clampedA).toEqual([100n, 200n]);
    expect(clampedB).toEqual([150n, 100n]);
  });

  it("clamps proportionally when total exceeds available", () => {
    const amountsA = [300n, 300n]; // total = 600, available = 400
    const { clampedA } = clampToAvailable(amountsA, [0n, 0n], 400n, 0n);
    const totalClamped = clampedA.reduce((s, v) => s + v, 0n);
    expect(totalClamped).toBeLessThanOrEqual(400n);
  });

  it("clamped total exactly equals available (no dust loss for uniform weights)", () => {
    const amountsA = [500n, 500n]; // total 1000, available 800
    const { clampedA } = clampToAvailable(amountsA, [0n, 0n], 800n, 0n);
    const total = clampedA.reduce((s, v) => s + v, 0n);
    expect(total).toBe(800n);
  });

  it("no negative values after clamping", () => {
    const amountsA = [1000n, 2000n, 3000n];
    const amountsB = [500n, 1000n];
    const { clampedA, clampedB } = clampToAvailable(amountsA, amountsB, 100n, 100n);
    for (const a of clampedA) expect(a).toBeGreaterThanOrEqual(0n);
    for (const b of clampedB) expect(b).toBeGreaterThanOrEqual(0n);
  });

  it("handles zero available (all clamped to 0)", () => {
    const amountsA = [100n, 200n];
    const { clampedA } = clampToAvailable(amountsA, [], 0n, 0n);
    for (const a of clampedA) expect(a).toBe(0n);
  });

  it("conservation: total clampedA ≤ availableA (bigint-safe)", () => {
    // Large amounts to test bigint safety
    const amountsA = [1_000_000_000_000n, 2_000_000_000_000n, 500_000_000_000n];
    const available = 1_500_000_000_000n;
    const { clampedA } = clampToAvailable(amountsA, [], available, 0n);
    const total = clampedA.reduce((s, v) => s + v, 0n);
    expect(total).toBeLessThanOrEqual(available);
    // Should equal exactly available since we distribute dust
    expect(total).toBe(available);
  });
});
