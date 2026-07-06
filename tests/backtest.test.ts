import { describe, it, expect } from "bun:test";
import { runBacktest, singleTick } from "../src/backtest/replay.ts";
import { priceFromBinId } from "../src/domain/binMath.ts";
import { emptyLendingState } from "../src/sui/lending/types.ts";
import type { PriceObservation } from "../src/domain/types.ts";
import type { PoolProfile } from "../src/pools/types.ts";

const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";

function testProfile(): PoolProfile {
  return {
    name: "test",
    poolId: "0xpool-test",
    coinTypeA: SUI,
    coinTypeB: USDC,
    decimalsA: 9,
    decimalsB: 6,
    binStep: 10,
    pricePairLabel: "SUI/USDC",
    defaultStrategyParams: { binWidth: 1, expectedFeeBps: 40 },
    lendingPolicy: {
      [SUI]: {
        minIdleBuffer: 100_000_000n,
        supplyThreshold: 500_000_000n,
        redeemHeadroom: 50_000_000n,
        apySwitchDeltaBps: 50,
      },
      [USDC]: {
        minIdleBuffer: 100_000n,
        supplyThreshold: 5_000_000n,
        redeemHeadroom: 500_000n,
        apySwitchDeltaBps: 50,
      },
    },
    network: "mainnet",
  };
}

/** Generate N observations centered around `price0` with random-walk Δp. */
function syntheticObservations(
  n: number,
  price0: number,
  stepBp: number,
  startMs: number,
  spacingMs: number,
  seed = 42,
): PriceObservation[] {
  let s = seed;
  const out: PriceObservation[] = [];
  let p = price0;
  for (let i = 0; i < n; i++) {
    // Deterministic pseudo-random walk for repeatable tests.
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const sign = (s & 1) === 0 ? 1 : -1;
    p = p * (1 + sign * (stepBp / 10_000));
    out.push({
      price: p.toFixed(10),
      timestampMs: startMs + i * spacingMs,
      source: "synthetic",
    });
  }
  return out;
}

describe("runBacktest", () => {
  it("returns one tick per observation with no plans for the singleBin strategy on a stable price", async () => {
    // Price held at the same bin should produce no rebalances after init.
    // After the first tick (init), the strategy emits one plan; the next ticks
    // see the position covering the active bin and emit quiet.
    const flat: PriceObservation[] = [];
    const price = priceFromBinId(-5990, 10, 9, 6);
    for (let i = 0; i < 5; i++) {
      flat.push({ price, timestampMs: 1_000_000 + i * 60_000, source: "flat" });
    }
    const result = await runBacktest({
      profile: testProfile(),
      strategyName: "singleBin",
      observations: flat,
      initialBalanceA: 100_000_000_000n,
      initialBalanceB: 250_000_000n,
      historyWindowMs: 5 * 60 * 1000,
    });
    expect(result.summary.totalTicks).toBe(5);
    // Tick 0: init plan (out of range because positionBins is empty).
    expect(result.summary.byKind.plan_and_reconcile).toBe(1);
    // Ticks 1..4: in range, no fees → quiet.
    expect(result.summary.byKind.quiet).toBe(4);
    // The straddle touches the two bins adjacent to active (never active
    // itself — active-bin placement is forbidden by policy).
    expect(result.summary.uniqueBinsTouched).toBe(2);
  });

  it("emits multiple rebalances when the price walks far enough to exit the position", async () => {
    const obs = syntheticObservations(50, 2.5, 100, 1_000_000, 60_000, 7);
    const result = await runBacktest({
      profile: testProfile(),
      strategyName: "singleBin",
      observations: obs,
      initialBalanceA: 100_000_000_000n,
      initialBalanceB: 250_000_000n,
      historyWindowMs: 30 * 60 * 1000,
    });
    expect(result.summary.totalTicks).toBe(50);
    expect(result.summary.byKind.plan_and_reconcile).toBeGreaterThan(1);
    expect(result.summary.uniqueBinsTouched).toBeGreaterThan(1);
  });

  it("multiBinSpot deploys across multiple bins on first tick", async () => {
    const obs = syntheticObservations(10, 2.5, 20, 1_000_000, 60_000);
    const result = await runBacktest({
      profile: testProfile(),
      strategyName: "multiBinSpot",
      observations: obs,
      initialBalanceA: 100_000_000_000n,
      initialBalanceB: 250_000_000n,
      historyWindowMs: 30 * 60 * 1000,
    });
    expect(result.summary.totalTicks).toBe(10);
    expect(result.summary.uniqueBinsTouched).toBeGreaterThan(1);
  });

  it("throws on unknown strategy name", async () => {
    await expect(
      runBacktest({
        profile: testProfile(),
        strategyName: "doesNotExist",
        observations: [],
        initialBalanceA: 0n,
        initialBalanceB: 0n,
        historyWindowMs: 0,
      }),
    ).rejects.toThrow();
  });
});

describe("singleTick helper", () => {
  it("returns a strategy output for an isolated tick", async () => {
    const profile = testProfile();
    const price = priceFromBinId(-5990, 10, 9, 6);
    const obs: PriceObservation = { price, timestampMs: 1_000_000, source: "test" };

    const { output, pool } = await singleTick({
      profile,
      strategyName: "singleBin",
      pm: {
        pmId: "0xpm",
        owner: "0xowner",
        poolId: profile.poolId,
        coinTypeA: profile.coinTypeA,
        coinTypeB: profile.coinTypeB,
        balance: { a: 100_000_000_000n, b: 250_000_000n },
        feeBag: { a: 0n, b: 0n },
        positionBins: [],
        lending: emptyLendingState(),
      },
      observation: obs,
      history: [],
    });

    expect(pool.activeBinId).toBe(-5990);
    // Empty PM + balance → out-of-range path → plan_and_reconcile.
    expect(output.kind).toBe("plan_and_reconcile");
  });
});
