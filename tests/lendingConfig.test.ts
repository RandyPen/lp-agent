/**
 * Unit tests for the cross-protocol lending whitelist + dust thresholds.
 * See `src/sui/lending/lendingConfig.ts`.
 */

import { describe, it, expect } from "bun:test";
import {
  LENDING_OPPORTUNITIES,
  MIN_LENDING_DELTA_RAW,
  SCALLOP_MAINNET,
  SCALLOP_RESERVES,
  canLend,
  getCandidateOpportunities,
  getMinLendingDeltaRaw,
  getScallopCoinName,
  getScallopReserveByUnderlying,
  lendingProtocolsFor,
} from "../src/sui/lending/lendingConfig.ts";

const USDC_CANONICAL =
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const SUI_SHORT = "0x2::sui::SUI";
const SUI_LONG =
  "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const DEEP_CANONICAL =
  "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP";
const UNKNOWN_COIN = "0xfeedfacecafebabe::token::TOKEN";

describe("LENDING_OPPORTUNITIES shape", () => {
  it("contains the v1 expected entries (USDC/SUI/DEEP at both protocols)", () => {
    // 6 entries total: 3 coins × 2 protocols
    expect(LENDING_OPPORTUNITIES).toHaveLength(6);
    const coins = new Set(LENDING_OPPORTUNITIES.map((o) => o.underlyingType));
    expect(coins.size).toBe(3);
    const protocols = new Set(LENDING_OPPORTUNITIES.map((o) => o.protocol));
    expect(protocols).toEqual(new Set(["scallop", "kai"]));
  });

  it("every Scallop entry has a scallopCoinName", () => {
    for (const o of LENDING_OPPORTUNITIES) {
      if (o.protocol === "scallop") {
        expect(o.scallopCoinName).toBeTruthy();
      }
    }
  });

  it("every entry has minAprBps > 0", () => {
    for (const o of LENDING_OPPORTUNITIES) {
      expect(o.minAprBps).toBeGreaterThan(0);
    }
  });
});

describe("canLend", () => {
  it("accepts canonical USDC", () => {
    expect(canLend(USDC_CANONICAL)).toBe(true);
  });

  it("normalises SUI's short form", () => {
    expect(canLend(SUI_SHORT)).toBe(true);
  });

  it("normalises SUI's long form", () => {
    expect(canLend(SUI_LONG)).toBe(true);
  });

  it("accepts DEEP", () => {
    expect(canLend(DEEP_CANONICAL)).toBe(true);
  });

  it("rejects unknown coins", () => {
    expect(canLend(UNKNOWN_COIN)).toBe(false);
  });

  it("rejects garbage input gracefully (no throw)", () => {
    expect(canLend("not a coin type")).toBe(false);
    expect(canLend("")).toBe(false);
  });
});

describe("getCandidateOpportunities", () => {
  it("returns both protocols for USDC", () => {
    const candidates = getCandidateOpportunities(USDC_CANONICAL);
    expect(candidates.map((c) => c.protocol).sort()).toEqual(["kai", "scallop"]);
  });

  it("returns both protocols for SUI regardless of input form", () => {
    expect(getCandidateOpportunities(SUI_SHORT)).toHaveLength(2);
    expect(getCandidateOpportunities(SUI_LONG)).toHaveLength(2);
  });

  it("returns empty array for unknown coin", () => {
    expect(getCandidateOpportunities(UNKNOWN_COIN)).toEqual([]);
  });
});

describe("getMinLendingDeltaRaw", () => {
  it("returns 1 USDC raw for USDC", () => {
    expect(getMinLendingDeltaRaw(USDC_CANONICAL)).toBe(1_000_000n);
  });

  it("returns 1 SUI raw for SUI (short form)", () => {
    expect(getMinLendingDeltaRaw(SUI_SHORT)).toBe(1_000_000_000n);
  });

  it("returns 10 DEEP raw for DEEP", () => {
    expect(getMinLendingDeltaRaw(DEEP_CANONICAL)).toBe(10_000_000n);
  });

  it("returns MAX_U64 sentinel for unknown coin (forces explicit registration)", () => {
    const expected = (1n << 64n) - 1n;
    expect(getMinLendingDeltaRaw(UNKNOWN_COIN)).toBe(expected);
  });

  it("MIN_LENDING_DELTA_RAW keys cover every coin in LENDING_OPPORTUNITIES", () => {
    const opportunityCoins = new Set(
      LENDING_OPPORTUNITIES.map((o) => o.underlyingType),
    );
    const dustCoins = new Set(Object.keys(MIN_LENDING_DELTA_RAW));
    for (const c of opportunityCoins) {
      expect(dustCoins.has(c)).toBe(true);
    }
  });
});

describe("getScallopCoinName", () => {
  it("returns the SDK key for whitelisted coins", () => {
    expect(getScallopCoinName(USDC_CANONICAL)).toBe("usdc");
    expect(getScallopCoinName(SUI_SHORT)).toBe("sui");
    expect(getScallopCoinName(DEEP_CANONICAL)).toBe("deep");
  });

  it("returns null for unknown coins", () => {
    expect(getScallopCoinName(UNKNOWN_COIN)).toBeNull();
  });
});

describe("lendingProtocolsFor", () => {
  it("USDC supports both protocols", () => {
    expect(lendingProtocolsFor(USDC_CANONICAL).sort()).toEqual(["kai", "scallop"]);
  });

  it("unknown coin returns empty array", () => {
    expect(lendingProtocolsFor(UNKNOWN_COIN)).toEqual([]);
  });
});

describe("SCALLOP_MAINNET constants", () => {
  it("exposes the four shared object IDs the SDK + offline path need", () => {
    expect(SCALLOP_MAINNET.PROTOCOL_PACKAGE_ID).toMatch(/^0x[0-9a-f]{64}$/);
    expect(SCALLOP_MAINNET.VERSION_ID).toMatch(/^0x[0-9a-f]{64}$/);
    expect(SCALLOP_MAINNET.MARKET_ID).toMatch(/^0x[0-9a-f]{64}$/);
    expect(SCALLOP_MAINNET.COIN_DECIMALS_REGISTRY_ID).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("is readonly (TypeScript const-asserted)", () => {
    // Compile-time guarantee via `as const`. Runtime check: enumerable + frozen-ish.
    const keys = Object.keys(SCALLOP_MAINNET).sort();
    expect(keys).toEqual([
      "COIN_DECIMALS_REGISTRY_ID",
      "MARKET_ID",
      "PROTOCOL_PACKAGE_ID",
      "VERSION_ID",
    ]);
  });
});

describe("SCALLOP_RESERVES", () => {
  it("has one entry per Scallop-eligible coin in LENDING_OPPORTUNITIES", () => {
    const scallopCoins = new Set(
      LENDING_OPPORTUNITIES.filter((o) => o.protocol === "scallop").map(
        (o) => o.underlyingType,
      ),
    );
    const reserveCoins = new Set(SCALLOP_RESERVES.map((r) => r.underlyingType));
    expect(reserveCoins).toEqual(scallopCoins);
  });

  it("every lendingPoolAddress is a 32-byte Sui object id", () => {
    for (const r of SCALLOP_RESERVES) {
      expect(r.lendingPoolAddress).toMatch(/^0x[0-9a-f]{64}$/);
    }
  });
});

describe("getScallopReserveByUnderlying", () => {
  it("returns the USDC reserve ref", () => {
    const ref = getScallopReserveByUnderlying(USDC_CANONICAL);
    expect(ref).toBeDefined();
    expect(ref?.underlyingType).toBe(USDC_CANONICAL);
    expect(ref?.lendingPoolAddress).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("normalises SUI short ↔ long form", () => {
    const fromShort = getScallopReserveByUnderlying(SUI_SHORT);
    const fromLong = getScallopReserveByUnderlying(SUI_LONG);
    expect(fromShort).toBeDefined();
    expect(fromShort?.lendingPoolAddress).toBe(fromLong?.lendingPoolAddress);
  });

  it("returns undefined for unknown coin", () => {
    expect(getScallopReserveByUnderlying(UNKNOWN_COIN)).toBeUndefined();
  });
});
