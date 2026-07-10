/**
 * tests/services/shadowBook.test.ts
 *
 * The shadow fill-accounting core:
 *   - parseSwapEvent: direction from the input coin type, crossed flags
 *     (all bin_swaps entries except the last), bin id decode
 *   - applySwap: pro-rata fill S·F/(S+F) on crossed bins only; terminal
 *     entries skipped (counted); fee credited pro-rata on the received side
 *   - applyPlan: removes → cash, adds ← cash (bounded)
 *   - NAV / HODL math on the inverted SUI/USDC profile
 *   - serialize/restore round-trip
 */

import { describe, it, expect } from "bun:test";
import {
  ShadowBook,
  parseSwapEvent,
  normalizeType,
  type RawDlmmSwapEvent,
} from "../../src/services/shadowBook.ts";
import type { PoolProfile } from "../../src/pools/types.ts";
import type { RebalancePlan } from "../../src/domain/types.ts";

const USDC = "0xdba3...::usdc::USDC"; // physical A (quote)
const SUI = "0x2::sui::SUI";          // physical B (base)

function makeProfile(): PoolProfile {
  return {
    name: "sui-usdc",
    poolId: "0xpool",
    coinTypeA: SUI,
    coinTypeB: USDC,
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
}

function plan(partial: Partial<RebalancePlan>): RebalancePlan {
  return {
    pmId: "shadow:test",
    removeShares: new Map(),
    addAmountA: 0n,
    addAmountB: 0n,
    addBins: [],
    addAmountsA: [],
    addAmountsB: [],
    collectFees: false,
    reason: "test",
    ...partial,
  };
}

function rawSwap(opts: {
  inputName: string;
  bins: { bin: number; amountIn: string; amountOut: string; fee: string }[];
}): RawDlmmSwapEvent {
  return {
    pool: "0xpool",
    amount_in: "0",
    amount_out: "0",
    fee: "0",
    bin_swaps: opts.bins.map((b) => ({
      bin_id: { bits: b.bin >= 0 ? b.bin : b.bin + 0x100000000 },
      amount_in: b.amountIn,
      amount_out: b.amountOut,
      fee: b.fee,
    })),
    from: { name: opts.inputName },
    target: { name: opts.inputName === USDC ? SUI : USDC },
  };
}

describe("parseSwapEvent", () => {
  it("derives consumed side from the input type; last entry is terminal", () => {
    const parsed = parseSwapEvent(
      rawSwap({
        inputName: USDC, // taker pays USDC (physical A) → consumes B
        bins: [
          { bin: 100, amountIn: "500", amountOut: "700", fee: "2" },
          { bin: 101, amountIn: "300", amountOut: "400", fee: "1" },
        ],
      }),
      USDC,
      SUI,
      123,
    );
    expect(parsed.fills.length).toBe(2);
    expect(parsed.fills[0]!.consumedSide).toBe("b");
    expect(parsed.fills[0]!.crossed).toBe(true);   // not last → fully crossed
    expect(parsed.fills[1]!.crossed).toBe(false);  // terminal
    expect(parsed.fills[0]!.consumedRaw).toBe(700n);
    expect(parsed.fills[0]!.paidRaw).toBe(500n);
  });

  it("throws on an unrecognizable input type (no silent direction guess)", () => {
    expect(() =>
      parseSwapEvent(
        rawSwap({ inputName: "0xdead::beef::BEEF", bins: [{ bin: 1, amountIn: "1", amountOut: "1", fee: "0" }] }),
        USDC,
        SUI,
        0,
      ),
    ).toThrow();
  });

  it("normalizeType strips 0x and leading zeros", () => {
    expect(normalizeType("0x0002::sui::SUI")).toBe("2::sui::sui");
  });
});

describe("ShadowBook fills", () => {
  it("crossed bin: pro-rata S·F/(S+F) with fee credited on the received side", () => {
    const book = new ShadowBook(makeProfile(), 0n, 0n);
    // Our hypothetical 1000 raw B (SUI) parked at bin 100.
    book.bins.set(100, { a: 0n, b: 1000n });
    book.applySwap(
      parseSwapEvent(
        rawSwap({
          inputName: USDC, // consumes B at bin 100 (crossed), terminal at 101
          bins: [
            { bin: 100, amountIn: "3000", amountOut: "3000", fee: "300" },
            { bin: 101, amountIn: "10", amountOut: "10", fee: "1" },
          ],
        }),
        USDC, SUI, 0,
      ),
    );
    const bin = book.bins.get(100)!;
    // my = 1000×3000/(1000+3000) = 750 of B consumed
    expect(bin.b).toBe(250n);
    // received = 3000×1000/4000 = 750 A, fee share = 300×1000/4000 = 75 A
    expect(bin.a).toBe(825n);
    expect(book.feeIncomeA).toBe(75n);
    expect(book.fills).toBe(1);
    expect(book.skippedTerminalFills).toBe(0); // no holdings at 101
  });

  it("terminal bin with holdings is skipped and counted (lower bound)", () => {
    const book = new ShadowBook(makeProfile(), 0n, 0n);
    book.bins.set(101, { a: 0n, b: 1000n });
    book.applySwap(
      parseSwapEvent(
        rawSwap({
          inputName: USDC,
          bins: [{ bin: 101, amountIn: "500", amountOut: "500", fee: "5" }],
        }),
        USDC, SUI, 0,
      ),
    );
    expect(book.bins.get(101)!.b).toBe(1000n); // untouched
    expect(book.skippedTerminalFills).toBe(1);
    expect(book.fills).toBe(0);
  });

  it("micro dust flow yields a proportionally micro fill (bin-move ≠ volume)", () => {
    const book = new ShadowBook(makeProfile(), 0n, 0n);
    book.bins.set(100, { a: 0n, b: 1_000_000n });
    book.applySwap(
      parseSwapEvent(
        rawSwap({
          inputName: USDC,
          bins: [
            { bin: 100, amountIn: "10", amountOut: "10", fee: "0" }, // dust crossing
            { bin: 101, amountIn: "1", amountOut: "1", fee: "0" },
          ],
        }),
        USDC, SUI, 0,
      ),
    );
    // my = 1e6×10/(1e6+10) ≈ 9 — the dust crossing converts ~nothing.
    expect(book.bins.get(100)!.b).toBeGreaterThan(999_990n);
  });
});

describe("ShadowBook plans / NAV / persistence", () => {
  it("applyPlan: removes to cash, adds from cash (bounded)", () => {
    const book = new ShadowBook(makeProfile(), 1_000n, 2_000n);
    book.applyPlan(plan({
      addBins: [10, 11],
      addAmountsA: [600n, 0n],
      addAmountsB: [0n, 1_500n],
      addAmountA: 600n,
      addAmountB: 1_500n,
    }));
    expect(book.cashA).toBe(400n);
    expect(book.cashB).toBe(500n);
    book.applyPlan(plan({ removeShares: new Map([[10, 1n], [11, 1n]]) }));
    expect(book.cashA).toBe(1_000n);
    expect(book.cashB).toBe(2_000n);
    expect(book.bins.size).toBe(0);
  });

  it("NAV and HODL in human quote units (inverted pool)", () => {
    // 65 USDC (raw 65e6, physical A, 6dp) + 20 SUI (raw 2e10, physical B, 9dp)
    const book = new ShadowBook(makeProfile(), 65_000_000n, 20_000_000_000n);
    const nav = book.navQuote(0.75);
    expect(nav).toBeCloseTo(65 + 20 * 0.75, 6);
    expect(book.hodlQuote(0.75)).toBeCloseTo(nav, 6); // untouched book = HODL
  });

  it("serialize/restore round-trip preserves everything", () => {
    const book = new ShadowBook(makeProfile(), 100n, 200n);
    book.bins.set(5, { a: 10n, b: 20n });
    book.feeIncomeA = 7n;
    book.fills = 3;
    book.skippedTerminalFills = 2;
    const restored = ShadowBook.restore(makeProfile(), JSON.parse(JSON.stringify(book.serialize())));
    expect(restored.cashA).toBe(100n);
    expect(restored.bins.get(5)!.b).toBe(20n);
    expect(restored.feeIncomeA).toBe(7n);
    expect(restored.fills).toBe(3);
    expect(restored.skippedTerminalFills).toBe(2);
    expect(restored.hodlA).toBe(100n);
    expect(restored.navQuote(1)).toBeCloseTo(book.navQuote(1), 9);
  });
});
