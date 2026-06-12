/**
 * Regression tests for src/sui/lending/typeNorm.ts
 *
 * Verifies the case-preserving semantics introduced to fix the root-cause
 * design flaw where canonicalType() lowercased the entire tag, making
 * ::usdc::USDC and ::usdc::usdc collide — a lossy normalisation that caused
 * a live mainnet rejection on the Sui gasless allowlist.
 */

import { describe, it, expect } from "bun:test";
import { canonicalType } from "../../src/sui/lending/typeNorm.ts";

const USDC_SHORT = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const SUI_SHORT  = "0x2::sui::SUI";
const SUI_LONG   =
  "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

describe("canonicalType — address normalisation", () => {
  it("pads a short address to 32-byte (66-char) form", () => {
    const result = canonicalType(SUI_SHORT);
    const addrPart = result.split("::")[0]!;
    // 0x + 64 hex digits = 66 chars
    expect(addrPart.length).toBe(66);
    expect(addrPart.startsWith("0x")).toBe(true);
  });

  it("short and long forms of the same address produce identical output", () => {
    expect(canonicalType(SUI_SHORT)).toBe(canonicalType(SUI_LONG));
  });

  it("already-long-form address is idempotent", () => {
    expect(canonicalType(SUI_LONG)).toBe(canonicalType(canonicalType(SUI_LONG)));
  });

  it("address hex is lowercased (normalizeStructTag guarantee)", () => {
    const result = canonicalType(SUI_SHORT);
    const addrPart = result.split("::")[0]!;
    expect(addrPart).toBe(addrPart.toLowerCase());
  });
});

describe("canonicalType — case preservation (regression)", () => {
  it("preserves UPPERCASE struct name (::SUI not ::sui)", () => {
    const result = canonicalType(SUI_SHORT);
    expect(result.endsWith("::SUI")).toBe(true);
    expect(result).not.toContain("::sui::sui");
  });

  it("preserves UPPERCASE USDC struct name", () => {
    const result = canonicalType(USDC_SHORT);
    expect(result.endsWith("::USDC")).toBe(true);
    expect(result).not.toContain("::usdc::usdc");
  });

  it("does NOT equate ::USDC and ::usdc — case differences are preserved", () => {
    const withUpper = canonicalType(USDC_SHORT);
    const withLower = canonicalType(
      "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::usdc",
    );
    // After the fix these must NOT collide — they are distinct Move types.
    expect(withUpper).not.toBe(withLower);
  });

  it("two inputs with the same address but different struct casing are distinct", () => {
    // Upper OTW form (the real type)
    const sui = canonicalType("0x2::sui::SUI");
    // Hypothetical lowercase variant (not a real type, but must not collide)
    const suiLc = canonicalType("0x2::sui::sui");
    expect(sui).not.toBe(suiLc);
  });
});

describe("canonicalType — generic type parameters", () => {
  it("normalises address inside a generic parameter", () => {
    const pool = "0xfoo0000000000000000000000000000000000000000000000000000000000001::pool::Pool<0x2::sui::SUI>";
    // The inner 0x2 should be padded; struct name SUI preserved.
    const result = canonicalType(pool);
    expect(result).toContain("::SUI>");
    // Inner address should be padded.
    const inner = result.match(/<(.+)>/)?.[1] ?? "";
    const innerAddr = inner.split("::")[0]!;
    expect(innerAddr.length).toBe(66);
  });
});

describe("canonicalType — error resilience", () => {
  it("returns trimmed input when parsing fails (no throw)", () => {
    // Malformed tags should not throw.
    expect(() => canonicalType("not_a_type")).not.toThrow();
    expect(canonicalType("  not_a_type  ")).toBe("not_a_type");
  });
});
