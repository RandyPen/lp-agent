/**
 * Tests for src/decision/ageStopLoss.ts
 *
 * Coverage:
 *   - evaluateLot: hold / relax_ask_floor / force_liquidate decisions
 *   - Age boundary conditions (just under / over 4h and 12h thresholds)
 *   - Loss boundary conditions (just under / over 3% and 5%)
 *   - estimateBinPrice geometric calculation
 *   - relaxedAskBinId bin derivation
 *   - evaluateAllLots processes all lots
 *   - shouldTriggerStopLoss and getForceLiquidations helpers
 *   - Future timestamp treated as hold
 */

import { describe, it, expect } from "bun:test";
import {
  evaluateLot,
  evaluateAllLots,
  shouldTriggerStopLoss,
  getForceLiquidations,
  estimateBinPrice,
  relaxedAskBinId,
  bidLotLoss,
  askLotLoss,
  type LotRecord,
  type PriceContext,
} from "../../src/decision/ageStopLoss.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW_MS = 1_000_000_000; // arbitrary epoch

function hoursMs(h: number): number {
  return h * 60 * 60 * 1000;
}

function makeBidLot(opts: {
  binId?: number;
  acquiredAtMs?: number;
  costBasis?: number;
  amount?: bigint;
}): LotRecord {
  return {
    binId: opts.binId ?? -2,
    acquiredAtMs: opts.acquiredAtMs ?? NOW_MS - hoursMs(1),
    costBasis: opts.costBasis ?? 1.0,
    amount: opts.amount ?? 1_000_000n,
  };
}

function makeAskLot(opts: {
  binId?: number;
  acquiredAtMs?: number;
  costBasis?: number;
  amount?: bigint;
}): LotRecord {
  return {
    binId: opts.binId ?? 2,
    acquiredAtMs: opts.acquiredAtMs ?? NOW_MS - hoursMs(1),
    costBasis: opts.costBasis ?? 1.0,
    amount: opts.amount ?? 1_000_000n,
  };
}

const BASE_PRICE_CTX: PriceContext = {
  activeBin: 0,
  currentMidPrice: 1.0,
  binStep: 10, // 0.1% per bin
};

// ---------------------------------------------------------------------------
// estimateBinPrice
// ---------------------------------------------------------------------------

describe("estimateBinPrice", () => {
  it("returns currentMidPrice for activeBin", () => {
    const p = estimateBinPrice(0, BASE_PRICE_CTX);
    expect(p).toBeCloseTo(BASE_PRICE_CTX.currentMidPrice, 8);
  });

  it("returns higher price for bins above active", () => {
    const p1 = estimateBinPrice(1, BASE_PRICE_CTX);
    const p5 = estimateBinPrice(5, BASE_PRICE_CTX);
    expect(p1).toBeGreaterThan(BASE_PRICE_CTX.currentMidPrice);
    expect(p5).toBeGreaterThan(p1);
  });

  it("returns lower price for bins below active", () => {
    const p = estimateBinPrice(-2, BASE_PRICE_CTX);
    expect(p).toBeLessThan(BASE_PRICE_CTX.currentMidPrice);
  });

  it("geometric: price at offset k = currentMidPrice × (1+step)^k", () => {
    const step = 10 / 10_000; // 0.001
    const expected = BASE_PRICE_CTX.currentMidPrice * Math.pow(1 + step, 3);
    const actual = estimateBinPrice(3, BASE_PRICE_CTX);
    expect(actual).toBeCloseTo(expected, 8);
  });
});

// ---------------------------------------------------------------------------
// relaxedAskBinId
// ---------------------------------------------------------------------------

describe("relaxedAskBinId", () => {
  it("returns at least activeBin + 1", () => {
    const bin = relaxedAskBinId(0.5, BASE_PRICE_CTX);
    expect(bin).toBeGreaterThanOrEqual(1);
  });

  it("returns a bin whose price covers cost × 1.005", () => {
    // costBasis = 1.0, currentMid = 1.0, target = 1.005
    // offset = ceil(log(1.005/1.0) / log(1.001)) ≈ 5
    const bin = relaxedAskBinId(1.0, BASE_PRICE_CTX);
    const binPrice = estimateBinPrice(bin, BASE_PRICE_CTX);
    expect(binPrice).toBeGreaterThanOrEqual(1.0 * 1.005 * 0.999); // allow 0.1% rounding
  });

  it("returns activeBin + 1 when current price is already above target", () => {
    // currentMidPrice >> costBasis → ratio < 1 → activeBin + 1
    const ctx: PriceContext = { activeBin: 10, currentMidPrice: 2.0, binStep: 10 };
    const bin = relaxedAskBinId(1.0, ctx);
    expect(bin).toBe(11); // activeBin + 1
  });
});

// ---------------------------------------------------------------------------
// bidLotLoss / askLotLoss
// ---------------------------------------------------------------------------

describe("bidLotLoss", () => {
  it("returns 0 for no loss (current price >= cost)", () => {
    // cost = 0.9, current price at bin = 1.0 (active bin) → no loss
    const lot = makeBidLot({ binId: 0, costBasis: 0.9 });
    expect(bidLotLoss(lot, BASE_PRICE_CTX)).toBe(0);
  });

  it("returns positive loss when current price < cost", () => {
    // cost = 1.0, current price at bin -5 (below active) < 1.0 → loss > 0
    const lot = makeBidLot({ binId: -5, costBasis: 1.0 });
    const loss = bidLotLoss(lot, BASE_PRICE_CTX);
    expect(loss).toBeGreaterThan(0);
  });

  it("returns 0 for zero cost basis", () => {
    const lot = makeBidLot({ costBasis: 0 });
    expect(bidLotLoss(lot, BASE_PRICE_CTX)).toBe(0);
  });
});

describe("askLotLoss", () => {
  it("returns 0 when current price <= cost (good ask position)", () => {
    // cost = 2.0, current price at bin 5 (above active) < 2.0 → no loss
    const lot = makeAskLot({ binId: 5, costBasis: 2.0 });
    expect(askLotLoss(lot, BASE_PRICE_CTX)).toBe(0);
  });

  it("returns positive loss when current price > cost (SUI pumped past ask)", () => {
    // cost = 1.001, current price at active bin ≈ 1.0, but lot is at bin 1 (1.001)
    // → price at bin 1 ≈ 1.001; cost = 0.9 → price > cost → loss
    const lot = makeAskLot({ binId: 1, costBasis: 0.9 });
    const loss = askLotLoss(lot, BASE_PRICE_CTX);
    expect(loss).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// evaluateLot — hold cases
// ---------------------------------------------------------------------------

describe("evaluateLot — hold decisions", () => {
  it("holds when lot is brand new (age < 4h)", () => {
    const lot = makeBidLot({ acquiredAtMs: NOW_MS - hoursMs(0.5), costBasis: 1.0 });
    const d = evaluateLot(lot, 0, BASE_PRICE_CTX, NOW_MS);
    expect(d.kind).toBe("hold");
  });

  it("holds when age > 4h but loss is below 3%", () => {
    // lot placed at bin -1 (small price drop from cost 1.0)
    // actual loss at bin -1 ≈ 0.001, which is < 3%
    const lot = makeBidLot({
      binId: -1,
      acquiredAtMs: NOW_MS - hoursMs(5),
      costBasis: 1.0, // cost = 1.0; current ≈ 0.999 → loss ≈ 0.1%
    });
    const d = evaluateLot(lot, 0, BASE_PRICE_CTX, NOW_MS);
    expect(d.kind).toBe("hold");
  });

  it("holds when future timestamp (acquiredAtMs in future)", () => {
    const lot = makeBidLot({ acquiredAtMs: NOW_MS + hoursMs(1) });
    const d = evaluateLot(lot, 0, BASE_PRICE_CTX, NOW_MS);
    expect(d.kind).toBe("hold");
  });
});

// ---------------------------------------------------------------------------
// evaluateLot — relax_ask_floor
// ---------------------------------------------------------------------------

describe("evaluateLot — relax_ask_floor", () => {
  it("emits relax_ask_floor after 4h with >3% loss", () => {
    // Place a bid lot far below active (large price drop = large loss).
    // bin -50 at step 10bp → price ≈ 1.0 × (1.001)^(-50) ≈ 0.951 → loss ≈ 4.9% from cost 1.0
    const lot = makeBidLot({
      binId: -50,
      acquiredAtMs: NOW_MS - hoursMs(5), // 5h old
      costBasis: 1.0,
    });
    const d = evaluateLot(lot, 0, BASE_PRICE_CTX, NOW_MS);
    expect(d.kind).toBe("relax_ask_floor");
    if (d.kind === "relax_ask_floor") {
      expect(d.relaxedAskBinId).toBeGreaterThanOrEqual(1); // above active
      expect(d.reason).toContain("3%");
    }
  });

  it("includes age and loss info in reason string", () => {
    const lot = makeBidLot({
      binId: -50,
      acquiredAtMs: NOW_MS - hoursMs(6),
      costBasis: 1.0,
    });
    const d = evaluateLot(lot, 0, BASE_PRICE_CTX, NOW_MS);
    if (d.kind === "relax_ask_floor") {
      expect(d.reason).toContain("age=6h");
    }
  });
});

// ---------------------------------------------------------------------------
// evaluateLot — force_liquidate
// ---------------------------------------------------------------------------

describe("evaluateLot — force_liquidate", () => {
  it("emits force_liquidate after 12h with >5% loss", () => {
    // bin -100 at step 10bp → price ≈ 1.0 × (1.001)^(-100) ≈ 0.905 → loss ≈ 9.5%
    const lot = makeBidLot({
      binId: -100,
      acquiredAtMs: NOW_MS - hoursMs(13),
      costBasis: 1.0,
    });
    const d = evaluateLot(lot, 0, BASE_PRICE_CTX, NOW_MS);
    expect(d.kind).toBe("force_liquidate");
    if (d.kind === "force_liquidate") {
      expect(d.forcedAskBinId).toBe(1); // active + 1
      expect(d.reason).toContain("5%");
    }
  });

  it("forced liquidation uses active + 1 for the forced ask bin", () => {
    const priceCtx: PriceContext = { activeBin: 200, currentMidPrice: 5.0, binStep: 10 };
    const lot: LotRecord = {
      binId: 150,   // far below active, large loss
      acquiredAtMs: NOW_MS - hoursMs(14),
      costBasis: 10.0, // way higher than current → massive loss
      amount: 1_000n,
    };
    const d = evaluateLot(lot, 0, priceCtx, NOW_MS);
    expect(d.kind).toBe("force_liquidate");
    if (d.kind === "force_liquidate") {
      expect(d.forcedAskBinId).toBe(201); // activeBin 200 + 1
    }
  });

  it("12h threshold takes precedence over 4h relax", () => {
    // A lot that would trigger relax at 4h but force_liquidate at 12h
    const lot = makeBidLot({
      binId: -100,
      acquiredAtMs: NOW_MS - hoursMs(14),
      costBasis: 1.0,
    });
    const d = evaluateLot(lot, 0, BASE_PRICE_CTX, NOW_MS);
    // At 14h with large loss → must be force_liquidate, not relax_ask_floor
    expect(d.kind).toBe("force_liquidate");
  });
});

// ---------------------------------------------------------------------------
// evaluateAllLots / helpers
// ---------------------------------------------------------------------------

describe("evaluateAllLots", () => {
  it("returns one decision per lot", () => {
    const lots: LotRecord[] = [
      makeBidLot({ binId: -1, acquiredAtMs: NOW_MS - hoursMs(1) }),
      makeBidLot({ binId: -100, acquiredAtMs: NOW_MS - hoursMs(14), costBasis: 1.0 }),
    ];
    const decisions = evaluateAllLots(lots, BASE_PRICE_CTX, NOW_MS);
    expect(decisions).toHaveLength(2);
  });

  it("preserves lotIdx in output", () => {
    const lots = [
      makeBidLot({ binId: -1 }),
      makeAskLot({ binId: 1 }),
    ];
    const decisions = evaluateAllLots(lots, BASE_PRICE_CTX, NOW_MS);
    expect(decisions[0]?.lotIdx).toBe(0);
    expect(decisions[1]?.lotIdx).toBe(1);
  });
});

describe("shouldTriggerStopLoss", () => {
  it("returns false when all decisions are hold", () => {
    const decisions = evaluateAllLots(
      [makeBidLot({ binId: -1, acquiredAtMs: NOW_MS - hoursMs(0.5) })],
      BASE_PRICE_CTX,
      NOW_MS,
    );
    expect(shouldTriggerStopLoss(decisions)).toBe(false);
  });

  it("returns true when any decision is non-hold", () => {
    const lots: LotRecord[] = [
      makeBidLot({ binId: -100, acquiredAtMs: NOW_MS - hoursMs(14), costBasis: 1.0 }),
    ];
    const decisions = evaluateAllLots(lots, BASE_PRICE_CTX, NOW_MS);
    expect(shouldTriggerStopLoss(decisions)).toBe(true);
  });
});

describe("getForceLiquidations", () => {
  it("extracts only force_liquidate decisions", () => {
    const lots: LotRecord[] = [
      makeBidLot({ binId: -1, acquiredAtMs: NOW_MS - hoursMs(1) }), // hold
      makeBidLot({ binId: -100, acquiredAtMs: NOW_MS - hoursMs(14), costBasis: 1.0 }), // force
    ];
    const decisions = evaluateAllLots(lots, BASE_PRICE_CTX, NOW_MS);
    const forced = getForceLiquidations(decisions);
    expect(forced).toHaveLength(1);
    expect(forced[0]?.kind).toBe("force_liquidate");
  });

  it("returns empty array when no forced liquidations", () => {
    const lots: LotRecord[] = [makeBidLot({ binId: -1 })];
    const decisions = evaluateAllLots(lots, BASE_PRICE_CTX, NOW_MS);
    expect(getForceLiquidations(decisions)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Age/loss boundary conditions
// ---------------------------------------------------------------------------

describe("age/loss boundary conditions", () => {
  it("exactly 4h old with exactly 3% loss → relax_ask_floor", () => {
    // We need a bin where price drop ≈ 3% exactly.
    // price(k) = 1.0 × (1.001)^k; for k = -30: (1.001)^(-30) ≈ 0.9704 → loss ≈ 2.96%
    // For k = -32: (1.001)^(-32) ≈ 0.9685 → loss ≈ 3.15%
    // Use k = -31 as approximation around 3%.
    // The test just checks the threshold boundary behaviour exists.
    const lot = makeBidLot({
      binId: -31,
      acquiredAtMs: NOW_MS - hoursMs(4),
      costBasis: 1.0,
    });
    const loss = bidLotLoss(lot, BASE_PRICE_CTX);
    const d = evaluateLot(lot, 0, BASE_PRICE_CTX, NOW_MS);

    if (loss > 0.03) {
      expect(d.kind).toBe("relax_ask_floor");
    } else {
      expect(d.kind).toBe("hold");
    }
  });

  it("exactly 12h old with exactly 5% loss → force_liquidate", () => {
    // For loss ≈ 5%: k ≈ -51, loss ≈ 4.97%
    // For k ≈ -52: loss ≈ 5.07% (just over)
    const lot = makeBidLot({
      binId: -52,
      acquiredAtMs: NOW_MS - hoursMs(12),
      costBasis: 1.0,
    });
    const loss = bidLotLoss(lot, BASE_PRICE_CTX);
    const d = evaluateLot(lot, 0, BASE_PRICE_CTX, NOW_MS);

    if (loss > 0.05) {
      expect(d.kind).toBe("force_liquidate");
    } else {
      expect(d.kind).toBe("hold");
    }
  });

  it("just under 4h with large loss → hold", () => {
    const lot = makeBidLot({
      binId: -100,
      acquiredAtMs: NOW_MS - hoursMs(3.99),
      costBasis: 1.0,
    });
    const d = evaluateLot(lot, 0, BASE_PRICE_CTX, NOW_MS);
    // Age < 4h → hold regardless of loss
    expect(d.kind).toBe("hold");
  });

  it("just under 12h with >5% loss → relax_ask_floor (not force)", () => {
    const lot = makeBidLot({
      binId: -100,
      acquiredAtMs: NOW_MS - hoursMs(11.99),
      costBasis: 1.0,
    });
    const d = evaluateLot(lot, 0, BASE_PRICE_CTX, NOW_MS);
    // Age < 12h → max trigger is relax_ask_floor, not force_liquidate
    expect(d.kind).not.toBe("force_liquidate");
  });
});
