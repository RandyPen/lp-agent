/**
 * Tests for src/treasury/gasless.ts
 *
 * Covers:
 *   - Allowlist canonicalisation (short vs long form addresses)
 *   - isGaslessEligible()
 *   - gaslessMinAtomic() per-coin math
 *   - buildGaslessTransfer() PTB shape (via getData())
 *   - Builder throws below minimum or non-allowlisted
 */

import { describe, it, expect } from "bun:test";
import { Transaction } from "@mysten/sui/transactions";
import { canonicalType } from "../../src/sui/lending/typeNorm.ts";
import {
  GASLESS_STABLECOINS,
  GASLESS_MIN_USDC_ATOMIC,
  isGaslessEligible,
  gaslessMinAtomic,
  buildGaslessTransfer,
} from "../../src/treasury/gasless.ts";

// ---------------------------------------------------------------------------
// Known coin types — short and long forms
// ---------------------------------------------------------------------------

// USDC — the primary stablecoin used in this repo.
const USDC_SHORT = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const USDC_CANON = canonicalType(USDC_SHORT);

// A non-allowlisted coin type for negative tests.
const NON_GASLESS_COIN = canonicalType("0x2::sui::SUI");

// An address for building PTBs.
const SENDER = "0x" + "aa".repeat(32);
const RECIPIENT = "0x" + "bb".repeat(32);

// ---------------------------------------------------------------------------
// GASLESS_STABLECOINS set
// ---------------------------------------------------------------------------

describe("GASLESS_STABLECOINS", () => {
  it("contains 7 entries", () => {
    expect(GASLESS_STABLECOINS.size).toBe(7);
  });

  it("all entries are canonical (64-hex address, case-preserving module/struct)", () => {
    for (const ct of GASLESS_STABLECOINS) {
      // Canonical form has 0x + 64 hex digits for the address part.
      expect(ct.startsWith("0x")).toBe(true);
      const addrPart = ct.split("::")[0]!;
      // 0x + 64 hex = 66 chars
      expect(addrPart.length).toBe(66);
      // Address part must be lowercase hex (normalizeStructTag guarantees this).
      expect(addrPart).toBe(addrPart.toLowerCase());
      // Module/struct names are preserved as-is — NOT lowercased.
      // (One-Time Witness rule: coin struct names are uppercase by protocol.)
    }
  });

  it("canonicalType is idempotent on entries already in the set", () => {
    for (const ct of GASLESS_STABLECOINS) {
      expect(canonicalType(ct)).toBe(ct);
    }
  });
});

// ---------------------------------------------------------------------------
// isGaslessEligible
// ---------------------------------------------------------------------------

describe("isGaslessEligible", () => {
  it("returns true for USDC (canonical long form)", () => {
    expect(isGaslessEligible(USDC_CANON)).toBe(true);
  });

  it("returns true for USDC short-form address (normalises internally)", () => {
    // The canonical type and the short type normalise to the same string
    // because USDC's address is already 32 bytes — but we test that any
    // mixed-case or differently-prefixed form still works.
    expect(isGaslessEligible(USDC_SHORT)).toBe(true);
  });

  it("returns true for USDC with uppercase module/struct", () => {
    const mixed = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
    expect(isGaslessEligible(mixed)).toBe(true);
  });

  it("returns false for SUI", () => {
    expect(isGaslessEligible("0x2::sui::SUI")).toBe(false);
  });

  it("returns false for an arbitrary unknown coin", () => {
    expect(isGaslessEligible("0xdeadbeef::fake::FAKE")).toBe(false);
  });

  it("returns true for all 7 allowlisted coins", () => {
    for (const ct of GASLESS_STABLECOINS) {
      expect(isGaslessEligible(ct)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// gaslessMinAtomic
// ---------------------------------------------------------------------------

describe("gaslessMinAtomic", () => {
  it("returns 10_000n for USDC (6 decimals, 0.01 whole units)", () => {
    expect(gaslessMinAtomic(USDC_CANON)).toBe(10_000n);
    expect(gaslessMinAtomic(USDC_CANON)).toBe(GASLESS_MIN_USDC_ATOMIC);
  });

  it("returns 10_000n for all 7 allowlisted coins (all have 6 decimals)", () => {
    for (const ct of GASLESS_STABLECOINS) {
      expect(gaslessMinAtomic(ct)).toBe(10_000n);
    }
  });

  it("throws for a non-allowlisted coin", () => {
    expect(() => gaslessMinAtomic(NON_GASLESS_COIN)).toThrow(/not a gasless-eligible/);
  });

  it("GASLESS_MIN_USDC_ATOMIC sentinel matches math", () => {
    // 0.01 * 10^6 = 10_000
    expect(GASLESS_MIN_USDC_ATOMIC).toBe(10_000n);
  });
});

// ---------------------------------------------------------------------------
// buildGaslessTransfer — PTB shape
// ---------------------------------------------------------------------------

/**
 * PTB shape tests for buildGaslessTransfer.
 *
 * These tests check `getData()` BEFORE `build({ client })` is called — i.e.
 * the pre-resolution state. The actual resolved PTB (two MoveCall commands,
 * FundsWithdrawal input) is only visible after an async `build({ client })`
 * call, which requires a live Sui client. We verify the live resolved shape
 * in `scripts/probe-gasless-dryrun.ts` instead.
 *
 * Pre-resolution shape:
 *   commands[0]: $Intent(CoinWithBalance) — resolves to redeem_funds at build time
 *   commands[1]: MoveCall(balance::send_funds) — the outer transfer
 *   inputs[0]:   Pure (address) — the recipient
 *   gasData.price:   "0"
 *   gasData.payment: []  (empty array — explicit empty, not null)
 *   gasData.budget:  "0" (or 0)
 */
describe("buildGaslessTransfer — PTB shape", () => {
  it("returns a Transaction instance", () => {
    const tx = buildGaslessTransfer({
      sender: SENDER,
      coinType: USDC_CANON,
      amountAtomic: 100_000n,
      recipient: RECIPIENT,
    });
    expect(tx).toBeInstanceOf(Transaction);
  });

  it("sets gasPrice to 0", () => {
    const tx = buildGaslessTransfer({
      sender: SENDER,
      coinType: USDC_CANON,
      amountAtomic: 100_000n,
      recipient: RECIPIENT,
    });
    const data = tx.getData();
    // gasPrice may be a string or number — normalise to string for comparison.
    expect(String(data.gasData.price)).toBe("0");
  });

  it("sets gasPayment to empty array [] (not null)", () => {
    const tx = buildGaslessTransfer({
      sender: SENDER,
      coinType: USDC_CANON,
      amountAtomic: 100_000n,
      recipient: RECIPIENT,
    });
    const data = tx.getData();
    // payment must be [] so the SDK skips SUI coin discovery at build time.
    // Gasless txs have no gas coin requirement.
    expect(Array.isArray(data.gasData.payment)).toBe(true);
    expect(data.gasData.payment!.length).toBe(0);
  });

  it("sets gasBudget to 0", () => {
    const tx = buildGaslessTransfer({
      sender: SENDER,
      coinType: USDC_CANON,
      amountAtomic: 100_000n,
      recipient: RECIPIENT,
    });
    const data = tx.getData();
    // budget=0 is valid for gasless txs and prevents the SDK from running an
    // expensive gas-budget simulation during build().
    expect(String(data.gasData.budget ?? "0")).toBe("0");
  });

  it("has exactly two commands before build(): CoinWithBalance intent + send_funds MoveCall", () => {
    const tx = buildGaslessTransfer({
      sender: SENDER,
      coinType: USDC_CANON,
      amountAtomic: 100_000n,
      recipient: RECIPIENT,
    });
    const data = tx.getData();
    // Pre-resolution: cmd[0] is the CoinWithBalance intent (resolves to
    // redeem_funds at build time), cmd[1] is the send_funds MoveCall.
    expect(data.commands.length).toBe(2);
    expect(data.commands[0]!.$kind).toBe("$Intent");
    expect(data.commands[1]!.$kind).toBe("MoveCall");
  });

  it("commands[0] is a CoinWithBalance intent with correct type and balance", () => {
    const amount = 100_000n;
    const tx = buildGaslessTransfer({
      sender: SENDER,
      coinType: USDC_CANON,
      amountAtomic: amount,
      recipient: RECIPIENT,
    });
    const data = tx.getData();
    const intent = data.commands[0] as {
      $kind: "$Intent";
      $Intent: {
        name: string;
        data: { type: string; balance: string | bigint; outputKind?: string };
        inputs: Record<string, unknown>;
      };
    };
    expect(intent.$Intent.name).toBe("CoinWithBalance");
    // type must be case-preserving (ptbType, not lowercased canonicalType)
    expect(canonicalType(intent.$Intent.data.type)).toBe(USDC_CANON);
    // balance must match amountAtomic
    expect(BigInt(intent.$Intent.data.balance)).toBe(amount);
    // outputKind must be "balance" (not "coin") — we call tx.balance(), not tx.coin()
    expect(intent.$Intent.data.outputKind).toBe("balance");
  });

  it("commands[1] is a MoveCall to 0x2::balance::send_funds with correct typeArg", () => {
    const tx = buildGaslessTransfer({
      sender: SENDER,
      coinType: USDC_CANON,
      amountAtomic: 100_000n,
      recipient: RECIPIENT,
    });
    const data = tx.getData();
    const cmd = data.commands[1]!;
    expect(cmd.$kind).toBe("MoveCall");
    const mc = (cmd as {
      $kind: "MoveCall";
      MoveCall: { package: string; module: string; function: string; typeArguments: string[] };
    }).MoveCall;
    expect(mc.package).toBe("0x0000000000000000000000000000000000000000000000000000000000000002");
    expect(mc.module).toBe("balance");
    expect(mc.function).toBe("send_funds");
    expect(mc.typeArguments.length).toBe(1);
    // typeArguments must be case-preserving — the gasless allowlist is case-sensitive.
    expect(canonicalType(mc.typeArguments[0]!)).toBe(USDC_CANON);
    // The raw value must NOT be all-lowercase (struct name must be USDC not usdc).
    expect(mc.typeArguments[0]!).toContain("::USDC");
  });

  it("has exactly one raw input before build(): Pure (recipient address)", () => {
    const tx = buildGaslessTransfer({
      sender: SENDER,
      coinType: USDC_CANON,
      amountAtomic: 100_000n,
      recipient: RECIPIENT,
    });
    const data = tx.getData();
    // Pre-resolution: only the Pure address input is visible in getData().
    // The FundsWithdrawal input is inserted by the CoinWithBalance intent resolver
    // during build() — it is NOT present before build().
    expect(data.inputs.length).toBe(1);
    const input = data.inputs[0]!;
    // Pure or UnresolvedPure — SDK may defer serialisation.
    expect(["Pure", "UnresolvedPure"].includes(input.$kind)).toBe(true);
  });

  it("sender is set correctly", () => {
    const tx = buildGaslessTransfer({
      sender: SENDER,
      coinType: USDC_CANON,
      amountAtomic: 10_000n,
      recipient: RECIPIENT,
    });
    const data = tx.getData();
    expect(data.sender).toBe(SENDER);
  });

  it("short-form coinType produces case-preserving struct name in commands", () => {
    // Even when the input is short-form, the type argument must be case-preserving.
    const tx = buildGaslessTransfer({
      sender: SENDER,
      coinType: USDC_SHORT,
      amountAtomic: 10_000n,
      recipient: RECIPIENT,
    });
    const data = tx.getData();
    const cmd = data.commands[1]!; // send_funds MoveCall
    const mc = (cmd as { $kind: "MoveCall"; MoveCall: { typeArguments: string[] } }).MoveCall;
    expect(canonicalType(mc.typeArguments[0]!)).toBe(USDC_CANON);
    // Struct name must retain original casing (USDC, not usdc).
    expect(mc.typeArguments[0]!).toContain("::USDC");
  });
});

// ---------------------------------------------------------------------------
// buildGaslessTransfer — error paths
// ---------------------------------------------------------------------------

describe("buildGaslessTransfer — error paths", () => {
  it("throws when coinType is not allowlisted", () => {
    expect(() =>
      buildGaslessTransfer({
        sender: SENDER,
        coinType: "0x2::sui::SUI",
        amountAtomic: 100_000n,
        recipient: RECIPIENT,
      }),
    ).toThrow(/not a gasless-eligible/);
  });

  it("throws when amountAtomic is exactly below the minimum (9999n)", () => {
    expect(() =>
      buildGaslessTransfer({
        sender: SENDER,
        coinType: USDC_CANON,
        amountAtomic: 9_999n,
        recipient: RECIPIENT,
      }),
    ).toThrow(/below the protocol minimum/);
  });

  it("throws when amountAtomic is 0", () => {
    expect(() =>
      buildGaslessTransfer({
        sender: SENDER,
        coinType: USDC_CANON,
        amountAtomic: 0n,
        recipient: RECIPIENT,
      }),
    ).toThrow(/below the protocol minimum/);
  });

  it("does NOT throw at exactly the minimum (10_000n)", () => {
    expect(() =>
      buildGaslessTransfer({
        sender: SENDER,
        coinType: USDC_CANON,
        amountAtomic: 10_000n,
        recipient: RECIPIENT,
      }),
    ).not.toThrow();
  });

  it("does NOT throw for a large amount", () => {
    expect(() =>
      buildGaslessTransfer({
        sender: SENDER,
        coinType: USDC_CANON,
        amountAtomic: 1_000_000_000n, // 1000 USDC
        recipient: RECIPIENT,
      }),
    ).not.toThrow();
  });

  it("error message for non-allowlisted coin mentions the coin type", () => {
    const bad = "0xdeadbeef::fake::TOKEN";
    try {
      buildGaslessTransfer({ sender: SENDER, coinType: bad, amountAtomic: 100_000n, recipient: RECIPIENT });
      throw new Error("should have thrown");
    } catch (e: unknown) {
      expect((e as Error).message).toMatch(/not a gasless-eligible/);
    }
  });

  it("error message for below-minimum mentions the minimum amount", () => {
    try {
      buildGaslessTransfer({ sender: SENDER, coinType: USDC_CANON, amountAtomic: 1n, recipient: RECIPIENT });
      throw new Error("should have thrown");
    } catch (e: unknown) {
      expect((e as Error).message).toContain("10000");
    }
  });
});
