/**
 * ShadowBook — hypothetical per-strategy position book for shadow mode,
 * judged against REAL on-chain SwapEvents.
 *
 * Fill rule (operator study 2026-07, "bin 移动 ≠ 成交量"):
 * bin crossings are dominated by micro-volume noise (72% of crossing swaps
 * carry < $10), so "active bin crossed my range" would fabricate fills.
 * Instead every fill is judged pro-rata against the REAL per-bin flow the
 * DLMM `SwapEvent.bin_swaps` breakdown reports:
 *
 *     my_fill = S × F / (S + F)
 *
 * where S is our hypothetical size in the bin and F the real consumed
 * amount. Depth needs no chain read: every bin_swaps entry EXCEPT the last
 * was fully crossed, so its F equals the bin's entire depth at that moment.
 * The terminal (partially-consumed) entry is SKIPPED — a deliberate,
 * documented lower bound. The taker's fee is credited pro-rata from the
 * event's own per-bin fee field — real fee, not an estimate.
 *
 * Counterfactual caveat (documented): our presence would have deepened the
 * bins and slightly altered the path; the pro-rata dilution S/(S+F) prices
 * exactly that first-order effect, and validity requires S to stay small
 * relative to real flow — `skippedTerminalQuote` and the S/F ratios are
 * reported so the operator can see when the assumption strains.
 *
 * All amounts are RAW bigints on the pool's PHYSICAL sides (A/B), same
 * convention as PMState. NAV is reported in human quote units.
 */

import type { PMState, RebalancePlan } from "../domain/types.ts";
import type { PoolProfile } from "../pools/types.ts";
import { humanPriceForBin, orientationOf, type PoolOrientation } from "../domain/binMath.ts";
import { emptyLendingState } from "../sui/lending/types.ts";

// ---------------------------------------------------------------------------
// Swap-event shapes (full bin_swaps breakdown — richer than the price feed's)
// ---------------------------------------------------------------------------

/** One bin's slice of a swap, normalized to physical sides. */
export interface BinFill {
  binId: number;
  /** Which PHYSICAL side the taker consumed in this bin ("a" | "b"). */
  consumedSide: "a" | "b";
  /** Raw amount of the consumed side that traded in this bin. */
  consumedRaw: bigint;
  /** Raw amount of the received (input) side paid into this bin. */
  paidRaw: bigint;
  /** Taker fee for this bin, in the INPUT token (the side we receive). */
  feeRaw: bigint;
  /** True when the swap moved past this bin (fully consumed it). */
  crossed: boolean;
}

export interface ParsedSwap {
  timestampMs: number;
  fills: BinFill[];
}

/** Raw Cetus DLMM SwapEvent payload (mirrors the feed's private shape). */
export interface RawDlmmSwapEvent {
  pool: string;
  amount_in: string;
  amount_out: string;
  fee: string;
  bin_swaps: {
    bin_id: { bits: number };
    amount_in: string;
    amount_out: string;
    fee: string;
  }[];
  from: { name: string };
  target: { name: string };
}

function decodeBinId(bits: number): number {
  return bits >= 0x80000000 ? bits - 0x100000000 : bits;
}

/** Normalize a Move type tag for comparison (strip 0x, leading zeros, case). */
export function normalizeType(name: string): string {
  return name
    .toLowerCase()
    .replace(/^0x/, "")
    .replace(/^0+/, "");
}

/**
 * Parse a raw SwapEvent into physical-side bin fills.
 *
 * `physicalTypeA` is the pool's PHYSICAL coinA type tag. Direction: when the
 * taker's input token is physical A, the consumed side (their output) is B,
 * and vice versa. Throws on an unrecognizable input type — a mis-parsed
 * direction would corrupt every downstream fill, so fail loudly.
 */
export function parseSwapEvent(
  raw: RawDlmmSwapEvent,
  physicalTypeA: string,
  physicalTypeB: string,
  timestampMs: number,
): ParsedSwap {
  const fromNorm = normalizeType(raw.from.name);
  const aNorm = normalizeType(physicalTypeA);
  const bNorm = normalizeType(physicalTypeB);
  let inputIsA: boolean;
  if (fromNorm === aNorm || aNorm.endsWith(fromNorm) || fromNorm.endsWith(aNorm)) {
    inputIsA = true;
  } else if (fromNorm === bNorm || bNorm.endsWith(fromNorm) || fromNorm.endsWith(bNorm)) {
    inputIsA = false;
  } else {
    throw new Error(
      `shadowBook: swap input type '${raw.from.name}' matches neither physical side ` +
        `(A=${physicalTypeA}, B=${physicalTypeB})`,
    );
  }
  const consumedSide: "a" | "b" = inputIsA ? "b" : "a";

  const fills: BinFill[] = raw.bin_swaps.map((bs, i) => ({
    binId: decodeBinId(bs.bin_id.bits),
    consumedSide,
    consumedRaw: BigInt(bs.amount_out),
    paidRaw: BigInt(bs.amount_in),
    feeRaw: BigInt(bs.fee),
    crossed: i < raw.bin_swaps.length - 1,
  }));
  return { timestampMs, fills };
}

// ---------------------------------------------------------------------------
// The book
// ---------------------------------------------------------------------------

export interface ShadowBookState {
  cashA: string;
  cashB: string;
  bins: { binId: number; a: string; b: string }[];
  feeIncomeA: string;
  feeIncomeB: string;
  fills: number;
  skippedTerminalFills: number;
  /** HODL benchmark: the initial inventory, frozen. */
  hodlA: string;
  hodlB: string;
}

export class ShadowBook {
  cashA: bigint;
  cashB: bigint;
  bins = new Map<number, { a: bigint; b: bigint }>();
  feeIncomeA = 0n;
  feeIncomeB = 0n;
  fills = 0;
  skippedTerminalFills = 0;
  readonly hodlA: bigint;
  readonly hodlB: bigint;
  private readonly orientation: PoolOrientation;

  constructor(profile: PoolProfile, initialA: bigint, initialB: bigint) {
    this.orientation = orientationOf(profile);
    this.cashA = initialA;
    this.cashB = initialB;
    this.hodlA = initialA;
    this.hodlB = initialB;
  }

  /** Apply a strategy plan hypothetically: removes → cash, adds ← cash. */
  applyPlan(plan: RebalancePlan): void {
    for (const [binId] of plan.removeShares) {
      const b = this.bins.get(binId);
      if (!b) continue; // strategy referenced a bin we don't model — ignore
      this.cashA += b.a;
      this.cashB += b.b;
      this.bins.delete(binId);
    }
    plan.addBins.forEach((binId, i) => {
      let a = plan.addAmountsA[i] ?? 0n;
      let b = plan.addAmountsB[i] ?? 0n;
      // Bounded by available cash (mirrors rescalePlanToAvailable coarsely).
      if (a > this.cashA) a = this.cashA;
      if (b > this.cashB) b = this.cashB;
      if (a === 0n && b === 0n) return;
      const cur = this.bins.get(binId) ?? { a: 0n, b: 0n };
      cur.a += a;
      cur.b += b;
      this.bins.set(binId, cur);
      this.cashA -= a;
      this.cashB -= b;
    });
  }

  /**
   * Apply one real swap's bin fills pro-rata. Crossed bins use F as the full
   * depth (my = S·F/(S+F)); terminal bins are skipped (lower bound).
   */
  applySwap(swap: ParsedSwap): void {
    for (const f of swap.fills) {
      const bin = this.bins.get(f.binId);
      if (!bin) continue;
      const S = f.consumedSide === "a" ? bin.a : bin.b;
      if (S <= 0n) continue;
      if (!f.crossed) {
        this.skippedTerminalFills++;
        continue;
      }
      const F = f.consumedRaw;
      if (F <= 0n) continue;
      const my = (S * F) / (S + F);
      if (my <= 0n) continue;
      // We give up `my` of the consumed side and receive the taker's input
      // pro-rata to our share of the bin's total (S + F ≈ depth incl. us),
      // plus the same share of the taker's fee.
      const share = (x: bigint) => (x * S) / (S + F);
      const received = share(f.paidRaw);
      const feeShare = share(f.feeRaw);
      if (f.consumedSide === "a") {
        bin.a -= my;
        bin.b += received + feeShare;
        this.feeIncomeB += feeShare;
      } else {
        bin.b -= my;
        bin.a += received + feeShare;
        this.feeIncomeA += feeShare;
      }
      this.fills++;
    }
  }

  /** Totals across cash + bins, per physical side. */
  totals(): { a: bigint; b: bigint } {
    let a = this.cashA;
    let b = this.cashB;
    for (const bin of this.bins.values()) {
      a += bin.a;
      b += bin.b;
    }
    return { a, b };
  }

  /** NAV in human QUOTE units at the given human pair price. */
  navQuote(priceHuman: number): number {
    const { a, b } = this.totals();
    return this.valueQuote(a, b, priceHuman);
  }

  /** HODL benchmark NAV at the given price. */
  hodlQuote(priceHuman: number): number {
    return this.valueQuote(this.hodlA, this.hodlB, priceHuman);
  }

  /** Cumulative fee income in human quote units. */
  feeIncomeQuote(priceHuman: number): number {
    return this.valueQuote(this.feeIncomeA, this.feeIncomeB, priceHuman);
  }

  private valueQuote(a: bigint, b: bigint, priceHuman: number): number {
    const o = this.orientation;
    const aHuman = Number(a) / 10 ** o.poolCoinADecimals;
    const bHuman = Number(b) / 10 ** o.poolCoinBDecimals;
    // Physical A is the quote asset iff poolCoinAIsQuote; the other side is
    // valued through the human pair price (quote per base).
    return o.poolCoinAIsQuote ? aHuman + bHuman * priceHuman : bHuman + aHuman * priceHuman;
  }

  /** Synthetic PMState for feeding the strategy (v0-read fidelity: share only). */
  /**
   * Project the book as a PMState for `strategy.plan()`.
   *
   * `positionValue` is injected exactly as the live rebalancer injects it. The
   * rebalancer dryRuns the remove prefix (`estimateRemoveProceeds`) and passes
   * the proceeds in, because strategies are contracted to size adds from
   * `balance + feeBag + positionValue` — the capital they are about to free by
   * removing the current position.
   *
   * This used to report `amountA: 0n, amountB: 0n` per bin and no
   * `positionValue` at all, even though the book knows the per-bin amounts
   * precisely. A strategy recentering in shadow therefore saw ZERO deployable
   * capital (its balance having been spent on the previous add) and could only
   * withdraw, redeploying a tick later from the freed cash. That is not what
   * the live agent does — so the shadow book, the framework's honest evaluator,
   * was silently evaluating different behaviour than it would execute.
   *
   * No haircut is applied here: unlike the live dryRun (which discounts by
   * READD_PROCEEDS_HAIRCUT_BPS to absorb a bin-composition shift between
   * estimate and execution), the simulated book's amounts are exact.
   */
  toPmState(pmId: string, poolId: string, physicalTypeA: string, physicalTypeB: string): PMState {
    let positionA = 0n;
    let positionB = 0n;
    for (const v of this.bins.values()) {
      positionA += v.a;
      positionB += v.b;
    }

    return {
      pmId,
      owner: "0xshadow",
      poolId,
      coinTypeA: physicalTypeA,
      coinTypeB: physicalTypeB,
      balance: { a: this.cashA, b: this.cashB },
      feeBag: { a: 0n, b: 0n },
      positionBins: [...this.bins.entries()].map(([binId, v]) => ({
        binId,
        liquidityShare: v.a + v.b,
        amountA: v.a,
        amountB: v.b,
      })),
      ...(positionA > 0n || positionB > 0n
        ? { positionValue: { a: positionA, b: positionB } }
        : {}),
      lending: emptyLendingState(),
    };
  }

  /** Human price at a bin (for reporting). */
  priceAt(binId: number): number {
    return humanPriceForBin(this.orientation, binId);
  }

  // --- persistence -----------------------------------------------------------

  serialize(): ShadowBookState {
    return {
      cashA: this.cashA.toString(),
      cashB: this.cashB.toString(),
      bins: [...this.bins.entries()].map(([binId, v]) => ({
        binId, a: v.a.toString(), b: v.b.toString(),
      })),
      feeIncomeA: this.feeIncomeA.toString(),
      feeIncomeB: this.feeIncomeB.toString(),
      fills: this.fills,
      skippedTerminalFills: this.skippedTerminalFills,
      hodlA: this.hodlA.toString(),
      hodlB: this.hodlB.toString(),
    };
  }

  static restore(profile: PoolProfile, state: ShadowBookState): ShadowBook {
    const book = new ShadowBook(profile, BigInt(state.hodlA), BigInt(state.hodlB));
    book.cashA = BigInt(state.cashA);
    book.cashB = BigInt(state.cashB);
    for (const b of state.bins) {
      book.bins.set(b.binId, { a: BigInt(b.a), b: BigInt(b.b) });
    }
    book.feeIncomeA = BigInt(state.feeIncomeA);
    book.feeIncomeB = BigInt(state.feeIncomeB);
    book.fills = state.fills;
    book.skippedTerminalFills = state.skippedTerminalFills;
    return book;
  }
}
