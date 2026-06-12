/**
 * tests/lending/routerStateBias.test.ts
 *
 * Tests for the stateBias feature added to the lending router (W6).
 *
 * stateBias.targetLendingPct caps the supplyable amount at
 * floor(idle * targetLendingPct) for SUPPLY decisions.
 *
 * These tests focus on observable outcomes that don't require network calls:
 *   - When stateBias=0: supply is capped to 0 → supplyable < dustFloor → noop
 *   - When stateBias is absent and idle is below supplyThreshold: noop
 *   - Redeem decisions are NOT affected by stateBias=0
 *   - RouterInput accepts stateBias field (TypeScript structural typing test)
 */

import { describe, it, expect, beforeEach } from "bun:test";
import type { RouterInput } from "../../src/sui/lending/router.ts";
import { decide } from "../../src/sui/lending/router.ts";
import { resetConfigCacheForTests } from "../../src/config.ts";
import type { PMState } from "../../src/domain/types.ts";

// ---------------------------------------------------------------------------
// Setup: minimal config so loadConfig() doesn't fail.
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetConfigCacheForTests();
  process.env.SUI_NETWORK = "mainnet";
  process.env.AGENT_PRIVATE_KEY =
    "suiprivkey1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp2s4vr";
  process.env.EXPECTED_AGENT_ADDRESS =
    "0x0000000000000000000000000000000000000000000000000000000000000001";
  process.env.SUI_USDC_POOL_ID =
    "0x0000000000000000000000000000000000000000000000000000000000000001";
  process.env.LENDING_ENABLED = "true";
  process.env.LENDING_SCALLOP_ENABLED = "true";
  process.env.LENDING_KAI_ENABLED = "false";
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Use canonical coin types that lendingConfig.ts recognises.
const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

function makePm(idleB: bigint, lendingScallop?: PMState["lending"]["scallop"]): PMState {
  return {
    pmId: "0xpm",
    owner: "0xowner",
    poolId: "0xpool",
    coinTypeA: SUI,
    coinTypeB: USDC,
    balance: { a: 0n, b: idleB },
    feeBag: { a: 0n, b: 0n },
    positionBins: [],
    lending: {
      scallop: lendingScallop ?? {},
      kai: {},
    },
  };
}

const PROFILE: RouterInput["profile"] = {
  name: "sui-usdc",
  network: "mainnet",
  poolId: "0xpool",
  binStep: 10,
  coinTypeA: SUI,
  coinTypeB: USDC,
  decimalsA: 9,
  decimalsB: 6,
  pricePairLabel: "SUI/USDC",
  defaultStrategyParams: { binWidth: 7, expectedFeeBps: 40 },
  lendingPolicy: {
    [USDC]: {
      minIdleBuffer: 100_000n,       // 0.1 USDC
      supplyThreshold: 200_000n,     // 0.2 USDC
      redeemHeadroom: 50_000n,
      apySwitchDeltaBps: 100,
    },
  },
};

// ---------------------------------------------------------------------------
// Tests: stateBias TypeScript type shape (structural)
// ---------------------------------------------------------------------------

describe("router stateBias — type acceptance", () => {
  it("RouterInput accepts stateBias field without TypeScript error", () => {
    const input: RouterInput = {
      pm: makePm(0n),
      profile: PROFILE,
      shortfall: { a: 0n, b: 0n },
      stateBias: { targetLendingPct: 0.35 },
    };
    // The fact that this compiles is the test.
    expect(input.stateBias?.targetLendingPct).toBe(0.35);
  });

  it("RouterInput without stateBias compiles (backward compatibility)", () => {
    const input: RouterInput = {
      pm: makePm(0n),
      profile: PROFILE,
      shortfall: { a: 0n, b: 0n },
    };
    expect(input.stateBias).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: stateBias=0 results in noop for supply (no network needed)
// ---------------------------------------------------------------------------

describe("router stateBias — supply cap with stateBias=0", () => {
  it("with stateBias=0: supplyable is 0, results in noop (no supply decision)", async () => {
    // idle=2_000_000 → with no cap: supplyable=1_900_000 (above threshold)
    // With stateBias=0: biasedCap=0, supplyable capped to 0 → noop
    const pm = makePm(2_000_000n);
    const input: RouterInput = {
      pm,
      profile: PROFILE,
      shortfall: { a: 0n, b: 0n },
      stateBias: { targetLendingPct: 0 },
    };
    const { decisions } = await decide(input);
    // With stateBias=0, supplyable is capped at floor(2_000_000 * 0) = 0.
    // 0 < dustFloor → noop.
    const supply = decisions.find((d) => d.kind === "supply");
    expect(supply).toBeUndefined();
  });

  it("with stateBias=0: decisions contain only noop entries", async () => {
    const pm = makePm(5_000_000n);
    const input: RouterInput = {
      pm,
      profile: PROFILE,
      shortfall: { a: 0n, b: 0n },
      stateBias: { targetLendingPct: 0 },
    };
    const { decisions } = await decide(input);
    for (const d of decisions) {
      expect(d.kind).toBe("noop");
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: stateBias=0 does NOT block redeem (redeem is shortfall-driven)
// ---------------------------------------------------------------------------

describe("router stateBias — redeem not affected", () => {
  it("redeem fires when shortfall > 0, even with stateBias=0", async () => {
    // Supply a position to simulate an outstanding lending position.
    const supplied = {
      protocol: "scallop" as const,
      coinType: USDC,
      ytType: "",
      underlyingPrincipal: 1_000_000n,
      marketCoinAmount: 1_050_000n,
    };

    const pm = makePm(50_000n, { [USDC]: supplied });

    // Shortfall = 500_000: we need more USDC than we have idle.
    const input: RouterInput = {
      pm,
      profile: PROFILE,
      shortfall: { a: 0n, b: 500_000n },
      stateBias: { targetLendingPct: 0 }, // stateBias=0 must not block redeem
    };

    const { decisions } = await decide(input);
    // The redeem is decided BEFORE the supply cap is applied, so it should fire.
    const redeem = decisions.find((d) => d.kind === "redeem");
    expect(redeem).toBeDefined();
    if (redeem && redeem.kind === "redeem") {
      expect(redeem.coinType).toBe(USDC);
      expect(redeem.protocol).toBe("scallop");
    }
  });

  it("noop shortfall with stateBias=0 and no lending position yields noop", async () => {
    const pm = makePm(50_000n); // no lending position
    const input: RouterInput = {
      pm,
      profile: PROFILE,
      shortfall: { a: 0n, b: 0n },
      stateBias: { targetLendingPct: 0 },
    };
    const { decisions } = await decide(input);
    for (const d of decisions) {
      expect(d.kind).toBe("noop");
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: stateBias absent → same as baseline (backward compat)
// ---------------------------------------------------------------------------

describe("router stateBias — absent stateBias is backward compatible", () => {
  it("without stateBias: noop when idle below supplyThreshold", async () => {
    // idle=150_000 < supplyThreshold=200_000 → noop
    const pm = makePm(150_000n);
    const input: RouterInput = {
      pm,
      profile: PROFILE,
      shortfall: { a: 0n, b: 0n },
      // no stateBias
    };
    const { decisions } = await decide(input);
    const supply = decisions.find((d) => d.kind === "supply");
    expect(supply).toBeUndefined();
  });
});
