import { describe, it, expect } from "bun:test";
import {
  ceilDiv,
  LENDING_SAFE_MARGIN_WRAPPER_RAW,
  MAX_U64,
  applyYieldFee,
  capRedeemBurnRaw,
  computeExpectedUnderlyingKai,
  computeExpectedUnderlyingScallop,
  kaiPrincipalPortion,
  predictKaiRedeem,
  predictScallopRedeem,
  scallopPrincipalPortion,
  scoinToBurnForTargetNet,
  ytToBurnForTargetNet,
} from "../src/sui/lending/math.ts";

describe("ceilDiv", () => {
  it("ceils correctly", () => {
    expect(ceilDiv(10n, 3n)).toBe(4n);
    expect(ceilDiv(9n, 3n)).toBe(3n);
    expect(ceilDiv(0n, 3n)).toBe(0n);
  });

  it("rejects non-positive divisor", () => {
    expect(() => ceilDiv(10n, 0n)).toThrow();
    expect(() => ceilDiv(10n, -1n)).toThrow();
  });
});

describe("applyYieldFee", () => {
  it("taxes only the interest portion at 20%", () => {
    // Redeemed 102, principal 93 → interest 9 → fee 9 × 2000 / 10000 = 1.
    const out = applyYieldFee(102n, 93n, 2000n);
    expect(out.interest).toBe(9n);
    expect(out.feeAmount).toBe(1n);
    expect(out.toBalance).toBe(101n);
  });

  it("never taxes principal when redeemed <= principal", () => {
    const out = applyYieldFee(80n, 100n, 2000n);
    expect(out.interest).toBe(0n);
    expect(out.feeAmount).toBe(0n);
    expect(out.toBalance).toBe(80n);
  });

  it("rejects fee_rate above the on-chain cap (3000 bp)", () => {
    expect(() => applyYieldFee(100n, 50n, 3001n)).toThrow();
  });
});

describe("Scallop math", () => {
  // Worked example from scallop-lending-math.md §7.3:
  // S_vault=1000, P_vault=950, cash+debt-revenue=1100, supply=1050, fee=2000bp.
  const reserve = { cash: 1100n, debt: 0n, revenue: 0n, supply: 1050n };
  const vault = { scoinTotal: 1000n, principalTotal: 950n };
  const feeBp = 2000n;

  it("computeExpectedUnderlyingScallop matches doc example", () => {
    expect(computeExpectedUnderlyingScallop(reserve, 98n)).toBe(102n);
  });

  it("principalPortion respects floor and full-drain branches", () => {
    expect(scallopPrincipalPortion(950n, 1000n, 98n)).toBe(93n);
    expect(scallopPrincipalPortion(950n, 1000n, 1000n)).toBe(950n);
    expect(scallopPrincipalPortion(950n, 1000n, 5000n)).toBe(950n); // wantAmount >= sTotal
  });

  it("predictScallopRedeem reproduces the doc-§7.3 worked example", () => {
    const out = predictScallopRedeem(reserve, vault, 98n, feeBp);
    expect(out.expectedUnderlying).toBe(102n);
    expect(out.principalPortion).toBe(93n);
    expect(out.interest).toBe(9n);
    expect(out.feeAmount).toBe(1n);
    expect(out.toBalance).toBe(101n);
  });

  it("scoinToBurnForTargetNet hits the doc target of 100 net", () => {
    const n = scoinToBurnForTargetNet(reserve, vault, 100n, feeBp);
    // Doc example: 98 is the minimum N that yields >= 100 net.
    expect(n).toBe(98n);
    const sim = predictScallopRedeem(reserve, vault, n, feeBp);
    expect(sim.toBalance).toBeGreaterThanOrEqual(100n);
  });

  it("scoinToBurnForTargetNet returns MAX_U64 when the vault cannot satisfy", () => {
    // Asking for 10_000_000 net out of a 1000-sCoin vault: impossible.
    const n = scoinToBurnForTargetNet(reserve, vault, 10_000_000n, feeBp);
    expect(n).toBe(MAX_U64);
  });

  it("scoinToBurnForTargetNet returns 0 for non-positive target", () => {
    expect(scoinToBurnForTargetNet(reserve, vault, 0n, feeBp)).toBe(0n);
  });

  it("falls into no-interest branch when p <= pi", () => {
    // p = denom/supply = 1000/1050 < pi = 950/1000 — no interest, no fee.
    const r = { cash: 1000n, debt: 0n, revenue: 0n, supply: 1050n };
    const n = scoinToBurnForTargetNet(r, vault, 50n, 2000n);
    // ceil(50 × 1050 / 1000) = 53; floor(53 × 1000 / 1050) = 50.
    expect(n).toBe(53n);
    const sim = predictScallopRedeem(r, vault, n, 2000n);
    expect(sim.feeAmount).toBe(0n);
    expect(sim.toBalance).toBeGreaterThanOrEqual(50n);
  });
});

describe("Kai math", () => {
  // Worked example mirrors Scallop's §7.3 (kai-lending-math.md §7.3):
  // total_available=1100, yt_supply=1050, yt_in_pm=1000, principal=950.
  const vault = { totalAvailable: 1100n, ytSupply: 1050n };
  const pm = { ytInPm: 1000n, principalInPm: 950n };
  const feeBp = 2000n;

  it("computeExpectedUnderlyingKai matches doc example", () => {
    expect(computeExpectedUnderlyingKai(vault, 98n)).toBe(102n);
  });

  it("kaiPrincipalPortion behaves identically to Scallop's", () => {
    expect(kaiPrincipalPortion(950n, 1000n, 98n)).toBe(93n);
    expect(kaiPrincipalPortion(950n, 1000n, 1000n)).toBe(950n);
  });

  it("predictKaiRedeem reproduces the doc-§7.3 worked example", () => {
    const out = predictKaiRedeem(vault, pm, 98n, feeBp);
    expect(out.expectedUnderlying).toBe(102n);
    expect(out.principalPortion).toBe(93n);
    expect(out.feeAmount).toBe(1n);
    expect(out.toBalance).toBe(101n);
  });

  it("ytToBurnForTargetNet hits the doc target of 100 net", () => {
    const n = ytToBurnForTargetNet(vault, pm, 100n, feeBp);
    expect(n).toBe(98n);
    const sim = predictKaiRedeem(vault, pm, n, feeBp);
    expect(sim.toBalance).toBeGreaterThanOrEqual(100n);
  });

  it("ytToBurnForTargetNet returns MAX_U64 when PM-entry cannot satisfy", () => {
    expect(ytToBurnForTargetNet(vault, pm, 10_000_000n, feeBp)).toBe(MAX_U64);
  });
});

describe("capRedeemBurnRaw", () => {
  const margin = LENDING_SAFE_MARGIN_WRAPPER_RAW;

  it("returns null when the wrapper is below the safe margin", () => {
    expect(capRedeemBurnRaw(50n, margin)).toBeNull();
    expect(capRedeemBurnRaw(50n, margin - 1n)).toBeNull();
  });

  it("caps the burn at (wrapperRaw - safeMargin)", () => {
    // wrapper=1000, margin=100 → safeMax=900. Asking for 5000 → cap to 900.
    expect(capRedeemBurnRaw(5000n, 1000n)).toBe(900n);
  });

  it("returns the exact ask when below safeMax", () => {
    expect(capRedeemBurnRaw(500n, 1000n)).toBe(500n);
  });

  it("respects custom safeMargin overrides", () => {
    expect(capRedeemBurnRaw(5000n, 1000n, 50n)).toBe(950n);
  });
});
