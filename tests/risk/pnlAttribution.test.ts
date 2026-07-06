/**
 * tests/risk/pnlAttribution.test.ts
 *
 * Unit tests for src/risk/pnlAttribution.ts — in-memory PnL attribution.
 */

import { describe, it, expect } from "bun:test";
import { createPnlAttributor } from "../../src/risk/pnlAttribution.ts";

const POOL_A = "pool-a";
const POOL_B = "pool-b";
const NOW = 1_700_000_000_000;

function tick(
  poolId: string,
  ts: number,
  feeIncome: number,
  rebalanceCost: number,
  inventoryDelta: number,
  marketState: "NORMAL" | "TREND" | "EXTREME" | null = "NORMAL",
) {
  return { poolId, ts, feeIncome, rebalanceCost, inventoryDelta, marketState };
}

describe("createPnlAttributor", () => {
  it("records ticks and retrieves them", () => {
    const attr = createPnlAttributor({ nowMs: () => NOW });
    attr.record(tick(POOL_A, NOW - 1000, 10, 2, -1, "NORMAL"));
    attr.record(tick(POOL_A, NOW - 500, 20, 3, 2, "TREND"));

    const ticks = attr.ticks(POOL_A);
    expect(ticks).toHaveLength(2);
    expect(ticks[0]!.feeIncome).toBe(10);
    expect(ticks[1]!.feeIncome).toBe(20);
  });

  it("keeps pools isolated", () => {
    const attr = createPnlAttributor({ nowMs: () => NOW });
    attr.record(tick(POOL_A, NOW - 1000, 10, 0, 0, "NORMAL"));
    attr.record(tick(POOL_B, NOW - 1000, 50, 5, -5, "TREND"));

    expect(attr.ticks(POOL_A)).toHaveLength(1);
    expect(attr.ticks(POOL_B)).toHaveLength(1);
  });

  it("summarize returns correct aggregates", () => {
    const attr = createPnlAttributor({ nowMs: () => NOW });
    // Two NORMAL ticks and one EXTREME tick
    attr.record(tick(POOL_A, NOW - 3000, 10, 2, 1, "NORMAL"));
    attr.record(tick(POOL_A, NOW - 2000, 5, 1, -1, "NORMAL"));
    attr.record(tick(POOL_A, NOW - 1000, 0, 0.5, -3, "EXTREME"));

    const summary = attr.summarize(POOL_A, NOW - 5000);
    expect(summary.tickCount).toBe(3);
    expect(summary.totalFeeIncome).toBeCloseTo(15);
    expect(summary.totalRebalanceCost).toBeCloseTo(3.5);
    expect(summary.totalInventoryDelta).toBeCloseTo(-3);
    // netPnl = 15 - 3.5 + (-3) = 8.5
    expect(summary.netPnl).toBeCloseTo(8.5);
  });

  it("summarize per-state breakdown is correct", () => {
    const attr = createPnlAttributor({ nowMs: () => NOW });
    attr.record(tick(POOL_A, NOW - 3000, 10, 1, 2, "NORMAL"));
    attr.record(tick(POOL_A, NOW - 2000, 5, 0.5, -1, "NORMAL"));
    attr.record(tick(POOL_A, NOW - 1000, 0, 2, -5, "TREND"));

    const summary = attr.summarize(POOL_A, NOW - 5000);
    expect(summary.byState.NORMAL.tickCount).toBe(2);
    expect(summary.byState.NORMAL.feeIncome).toBeCloseTo(15);
    expect(summary.byState.NORMAL.netPnl).toBeCloseTo(15 - 1.5 + 1);

    expect(summary.byState.TREND.tickCount).toBe(1);
    expect(summary.byState.TREND.netPnl).toBeCloseTo(0 - 2 - 5);

    expect(summary.byState.EXTREME.tickCount).toBe(0);
  });

  it("summarize respects sinceMs window filter", () => {
    const attr = createPnlAttributor({ nowMs: () => NOW });
    attr.record(tick(POOL_A, NOW - 5000, 100, 50, 10, "NORMAL")); // outside window
    attr.record(tick(POOL_A, NOW - 1000, 10, 2, 1, "NORMAL"));    // inside window

    const summary = attr.summarize(POOL_A, NOW - 2000); // only last 2000ms
    expect(summary.tickCount).toBe(1);
    expect(summary.totalFeeIncome).toBeCloseTo(10);
  });

  it("summarize with untilMs excludes points at or after that time", () => {
    const attr = createPnlAttributor({ nowMs: () => NOW });
    attr.record(tick(POOL_A, NOW - 1000, 10, 0, 0, "NORMAL"));
    attr.record(tick(POOL_A, NOW,         20, 0, 0, "NORMAL")); // at untilMs — excluded

    const summary = attr.summarize(POOL_A, NOW - 5000, NOW);
    expect(summary.tickCount).toBe(1);
    expect(summary.totalFeeIncome).toBeCloseTo(10);
  });

  it("summarize returns zero summary when no ticks match", () => {
    const attr = createPnlAttributor({ nowMs: () => NOW });
    const summary = attr.summarize("no-pool", 0);
    expect(summary.tickCount).toBe(0);
    expect(summary.netPnl).toBe(0);
    expect(summary.byState.NORMAL.tickCount).toBe(0);
  });

  it("evictBefore removes old ticks", () => {
    const attr = createPnlAttributor({ nowMs: () => NOW });
    attr.record(tick(POOL_A, NOW - 5000, 1, 0, 0, "NORMAL"));
    attr.record(tick(POOL_A, NOW - 3000, 2, 0, 0, "NORMAL"));
    attr.record(tick(POOL_A, NOW - 1000, 3, 0, 0, "NORMAL"));

    attr.evictBefore(NOW - 2000);
    const ticks = attr.ticks(POOL_A);
    expect(ticks).toHaveLength(1);
    expect(ticks[0]!.feeIncome).toBe(3);
  });

  it("maxTicksPerPool limits stored entries", () => {
    const attr = createPnlAttributor({ nowMs: () => NOW, maxTicksPerPool: 3 });
    for (let i = 0; i < 10; i++) {
      attr.record(tick(POOL_A, NOW - (10 - i) * 1000, i, 0, 0, "NORMAL"));
    }
    const ticks = attr.ticks(POOL_A);
    expect(ticks.length).toBeLessThanOrEqual(3);
    // Should keep the most recent ones
    expect(ticks[ticks.length - 1]!.feeIncome).toBe(9);
  });

  it("unknown/null marketState goes into 'unknown' bucket", () => {
    const attr = createPnlAttributor({ nowMs: () => NOW });
    attr.record(tick(POOL_A, NOW - 1000, 5, 1, 0, null));
    const summary = attr.summarize(POOL_A, 0);
    expect(summary.byState.unknown.tickCount).toBe(1);
    expect(summary.byState.unknown.feeIncome).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Phase 1 additions — createPnl24hPctSource (the risk-monitor seam)
// ---------------------------------------------------------------------------

import { createPnl24hPctSource } from "../../src/risk/pnlAttribution.ts";

describe("createPnl24hPctSource", () => {
  it("returns null when NAV is unknown", () => {
    const attr = createPnlAttributor({ nowMs: () => NOW });
    attr.record(tick(POOL_A, NOW - 1000, 10, 0, 0));
    const src = createPnl24hPctSource({ attributor: attr, getNavUsd: () => null, nowMs: () => NOW });
    expect(src(POOL_A)).toBe(null);
  });

  it("returns null when NAV is zero or negative", () => {
    const attr = createPnlAttributor({ nowMs: () => NOW });
    attr.record(tick(POOL_A, NOW - 1000, 10, 0, 0));
    const zero = createPnl24hPctSource({ attributor: attr, getNavUsd: () => 0, nowMs: () => NOW });
    expect(zero(POOL_A)).toBe(null);
    const neg = createPnl24hPctSource({ attributor: attr, getNavUsd: () => -5, nowMs: () => NOW });
    expect(neg(POOL_A)).toBe(null);
  });

  it("returns null when the 24h window has zero ticks (no data ≠ 0% PnL)", () => {
    const attr = createPnlAttributor({ nowMs: () => NOW });
    // Only a tick OUTSIDE the 24h window.
    attr.record(tick(POOL_A, NOW - 25 * 60 * 60 * 1000, 10, 0, 0));
    const src = createPnl24hPctSource({ attributor: attr, getNavUsd: () => 1_000, nowMs: () => NOW });
    expect(src(POOL_A)).toBe(null);
  });

  it("computes netPnl / nav over the 24h window", () => {
    const attr = createPnlAttributor({ nowMs: () => NOW });
    // netPnl = (10 - 2 + (-58)) = -50 over a 1000 NAV → -5%
    attr.record(tick(POOL_A, NOW - 3600_000, 10, 2, -58));
    const src = createPnl24hPctSource({ attributor: attr, getNavUsd: () => 1_000, nowMs: () => NOW });
    expect(src(POOL_A)).toBeCloseTo(-0.05, 10);
  });
});
