/**
 * tests/services/pnlService.test.ts — NAV, entry snapshots, IL, 24h pct.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPnlService, type PnlService } from "../../src/services/pnlService.ts";
import type { PMState, RebalancePlan } from "../../src/domain/types.ts";
import type { PoolProfile } from "../../src/pools/types.ts";
import { emptyLendingState } from "../../src/sui/lending/types.ts";

const POOL_ID = "0xpool";
const PM_ID = "0xpm";
const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

/** SUI/USDC-shaped: physical Pool<USDC=6, SUI=9>, inverted; logical A=SUI. */
const PROFILE: PoolProfile = {
  name: "sui-usdc",
  poolId: POOL_ID,
  coinTypeA: "0x2::sui::SUI",
  coinTypeB: "0xu::usdc::USDC",
  decimalsA: 9,
  decimalsB: 6,
  poolCoinADecimals: 6,
  poolCoinBDecimals: 9,
  poolCoinAIsQuote: true,
  binStep: 50,
  pricePairLabel: "SUI/USDC",
  defaultStrategyParams: { binWidth: 10, expectedFeeBps: 25 },
  lendingPolicy: {},
  network: "mainnet",
};

function openTestDb(): Database {
  const db = new Database(":memory:");
  const here = dirname(fileURLToPath(import.meta.url));
  db.exec(readFileSync(resolve(here, "../../src/db/schema.sql"), "utf8"));
  return db;
}

function makePm(opts: {
  balanceA?: bigint; // physical A = USDC (6 dec)
  balanceB?: bigint; // physical B = SUI (9 dec)
  feeBagA?: bigint;
  feeBagB?: bigint;
  positionBins?: PMState["positionBins"];
} = {}): PMState {
  return {
    pmId: PM_ID,
    owner: "0xowner",
    poolId: POOL_ID,
    coinTypeA: "0xu::usdc::USDC",
    coinTypeB: "0x2::sui::SUI",
    balance: { a: opts.balanceA ?? 0n, b: opts.balanceB ?? 0n },
    feeBag: { a: opts.feeBagA ?? 0n, b: opts.feeBagB ?? 0n },
    positionBins: opts.positionBins ?? [],
    lending: emptyLendingState(),
  };
}

function makePlan(amountA: bigint, amountB: bigint): RebalancePlan {
  return {
    pmId: PM_ID,
    removeShares: new Map(),
    addAmountA: amountA,
    addAmountB: amountB,
    addBins: amountA > 0n || amountB > 0n ? [100] : [],
    addAmountsA: amountA > 0n || amountB > 0n ? [amountA] : [],
    addAmountsB: amountA > 0n || amountB > 0n ? [amountB] : [],
    collectFees: false,
    reason: "test",
  };
}

let db: Database;
let svc: PnlService;
let clock = NOW;

beforeEach(() => {
  db = openTestDb();
  clock = NOW;
  svc = createPnlService({ db, profile: PROFILE, nowMs: () => clock });
});

describe("computeNavUsd / valuePhysicalUsd", () => {
  it("values physical amounts through the inverted orientation", () => {
    // 100 USDC (physical A, quote) + 10 SUI (physical B, base) at spot 2.5
    // → 100 + 25 = 125 USD.
    expect(svc.valuePhysicalUsd(100_000_000n, 10_000_000_000n, 2.5)).toBeCloseTo(125, 6);
  });

  it("NAV = idle + fees when no position and no lending", () => {
    const pm = makePm({ balanceA: 50_000_000n, balanceB: 4_000_000_000n, feeBagA: 1_000_000n });
    // 50 USDC + 4 SUI×2.5 + 1 USDC fee = 61.
    expect(svc.computeNavUsd(pm, 2.5)).toBeCloseTo(61, 6);
  });

  it("open position is marked from the entry snapshot at the CURRENT spot", () => {
    svc.snapshotEntry(PM_ID, makePlan(20_000_000n, 8_000_000_000n), 2.0, NOW);
    const pm = makePm({
      balanceA: 10_000_000n,
      positionBins: [{ binId: 100, liquidityShare: 1n, amountA: 0n, amountB: 0n }],
    });
    // idle 10 USDC + position (20 USDC + 8 SUI × 3.0 = 44) = 54.
    expect(svc.computeNavUsd(pm, 3.0)).toBeCloseTo(54, 6);
  });

  it("lending principal is valued by logical coin type", () => {
    const pm = makePm({});
    pm.lending.scallop["0x2::sui::SUI"] = {
      protocol: "scallop",
      coinType: "0x2::sui::SUI",
      ytType: "",
      underlyingPrincipal: 2_000_000_000n, // 2 SUI (9 dec)
      marketCoinAmount: 0n,
    };
    expect(svc.computeNavUsd(pm, 2.5)).toBeCloseTo(5, 6);
  });

  it("throws on an invalid spot (fail loud)", () => {
    expect(() => svc.computeNavUsd(makePm(), NaN)).toThrow(RangeError);
  });
});

describe("snapshotEntry / computeIlUsd", () => {
  it("an empty-add plan clears the snapshot (position closed)", () => {
    svc.snapshotEntry(PM_ID, makePlan(1_000_000n, 0n), 2.0, NOW);
    svc.snapshotEntry(PM_ID, makePlan(0n, 0n), 2.0, NOW + 1);
    const pm = makePm({
      positionBins: [{ binId: 100, liquidityShare: 1n, amountA: 0n, amountB: 0n }],
    });
    // No snapshot → position contributes 0 (with a warning).
    expect(svc.computeNavUsd(pm, 2.0)).toBeCloseTo(0, 6);
  });

  it("IL = realized proceeds value − hold-value of the entry at current spot", () => {
    // Entry: 100 USDC + 40 SUI at spot 2.5 (value 200).
    svc.snapshotEntry(PM_ID, makePlan(100_000_000n, 40_000_000_000n), 2.5, NOW);
    // Price rises to 3.0. Hold-value = 100 + 40×3 = 220.
    // The LP position converted SUI→USDC on the way up: realized proceeds
    // 160 USDC + 18 SUI → 160 + 54 = 214. IL = −6.
    const il = svc.computeIlUsd(PM_ID, { a: 160_000_000n, b: 18_000_000_000n }, 3.0);
    expect(il).toBeCloseTo(-6, 6);
  });

  it("IL is null without an entry snapshot", () => {
    expect(svc.computeIlUsd(PM_ID, { a: 1n, b: 1n }, 2.0)).toBe(null);
  });
});

describe("get24hPnlPct", () => {
  function tickAt(tsMs: number, navUsd: number, pmId = PM_ID): void {
    svc.recordTick({
      poolId: POOL_ID,
      pmId,
      tsMs,
      feeIncomeUsd: 0,
      costCredits: 0,
      navUsd,
      ilUsd: null,
      marketState: "NORMAL",
      rebalanceId: null,
    });
  }

  it("null when no ticks exist", () => {
    expect(svc.get24hPnlPct(POOL_ID)).toBe(null);
  });

  it("null when coverage is under 20h (no fabricated near-zero PnL)", () => {
    tickAt(NOW - 2 * HOUR, 1_000);
    tickAt(NOW - 1 * HOUR, 900);
    expect(svc.get24hPnlPct(POOL_ID)).toBe(null);
  });

  it("−5% NAV decline over a covered window → −0.05", () => {
    tickAt(NOW - 23 * HOUR, 1_000);
    tickAt(NOW - 12 * HOUR, 980);
    tickAt(NOW - 1 * HOUR, 950);
    expect(svc.get24hPnlPct(POOL_ID)).toBeCloseTo(-0.05, 10);
  });

  it("aggregates across PMs of the same pool", () => {
    tickAt(NOW - 23 * HOUR, 1_000, "0xpm1");
    tickAt(NOW - 22 * HOUR, 500, "0xpm2");
    tickAt(NOW - 1 * HOUR, 900, "0xpm1");
    tickAt(NOW - 1 * HOUR, 450, "0xpm2");
    // (1350 − 1500) / 1500 = −0.10
    expect(svc.get24hPnlPct(POOL_ID)).toBeCloseTo(-0.10, 10);
  });

  it("null when the baseline NAV is zero", () => {
    tickAt(NOW - 23 * HOUR, 0);
    tickAt(NOW - 1 * HOUR, 100);
    expect(svc.get24hPnlPct(POOL_ID)).toBe(null);
  });
});
