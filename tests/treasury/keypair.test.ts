/**
 * Tests for src/sui/keypairs/treasury.ts — master singleton + per-user
 * derivation determinism. Uses the public BIP-39 test vector so no real
 * mnemonic ever lands in the test suite.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { resetConfigCacheForTests } from "../../src/config.ts";
import {
  getTreasuryMasterAddress,
  getTreasuryMasterKeypair,
  getUserDepositKeypair,
  deriveUserDepositAddress,
  resetTreasuryKeypairCacheForTests,
} from "../../src/sui/keypairs/treasury.ts";

const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

// Different mnemonic for agent role so we can verify isolation if both
// loaded (also a public BIP-39 test vector).
const AGENT_TEST_MNEMONIC =
  "legal winner thank year wave sausage worth useful legal winner thank yellow";
// EXPECTED_AGENT_ADDRESS is required by loadConfig; precompute it once.
const AGENT_EXPECTED_ADDR = Ed25519Keypair.deriveKeypair(
  AGENT_TEST_MNEMONIC,
  "m/44'/784'/1'/0'/0'",
).toSuiAddress();

const ENV_KEYS = [
  "AGENT_PRIVATE_KEY",
  "AGENT_MNEMONICS",
  "MNEMONICS",
  "EXPECTED_AGENT_ADDRESS",
  "TREASURY_ENABLED",
  "TREASURY_PRIVATE_KEY",
  "TREASURY_MNEMONICS",
  "TREASURY_MASTER_DERIVATION_PATH",
  "TREASURY_USER_BASE_PATH",
  "EXPECTED_TREASURY_MASTER_ADDRESS",
  "TREASURY_IDENTITY_FILE",
  "IDENTITY_FILES_DISABLED",
  "SUI_USDC_POOL_ID",
] as const;

const orig: Record<string, string | undefined> = {};

function snapshot(): void {
  for (const k of ENV_KEYS) orig[k] = process.env[k];
}
function restore(): void {
  for (const k of ENV_KEYS) {
    if (orig[k] === undefined) delete process.env[k];
    else process.env[k] = orig[k];
  }
}
function resetAll(): void {
  resetConfigCacheForTests();
  resetTreasuryKeypairCacheForTests();
}

beforeEach(() => {
  snapshot();
  for (const k of ENV_KEYS) delete process.env[k];
  // loadConfig requires both an agent key source and EXPECTED_AGENT_ADDRESS.
  process.env.AGENT_MNEMONICS = AGENT_TEST_MNEMONIC;
  process.env.EXPECTED_AGENT_ADDRESS = AGENT_EXPECTED_ADDR;
  process.env.SUI_USDC_POOL_ID = "0xpool";
  process.env.TREASURY_ENABLED = "true";
  // TOFU identity file would persist across rotations; disable for unit tests.
  process.env.IDENTITY_FILES_DISABLED = "true";
  process.env.TREASURY_MNEMONICS = TEST_MNEMONIC;
  resetAll();
});

afterAll(() => {
  restore();
  resetAll();
});

describe("treasury master keypair", () => {
  it("derives at the default master path m/44'/784'/0'/0'/0'", () => {
    const addr = getTreasuryMasterAddress();
    expect(addr).toMatch(/^0x[0-9a-f]{64}$/);
    // Same mnemonic at path 1'/0'/0' (agent default) → DIFFERENT address.
    process.env.TREASURY_MASTER_DERIVATION_PATH = "m/44'/784'/1'/0'/0'";
    resetAll();
    expect(getTreasuryMasterAddress()).not.toBe(addr);
  });

  it("singleton cache returns the same keypair instance", () => {
    const a = getTreasuryMasterKeypair();
    const b = getTreasuryMasterKeypair();
    expect(a).toBe(b);
  });

  it("EXPECTED_TREASURY_MASTER_ADDRESS mismatch throws", () => {
    // Properly-formatted (64-hex) but wrong address — passes config-level
    // format check and fails at resolveKeypair address comparison.
    process.env.EXPECTED_TREASURY_MASTER_ADDRESS = "0x" + "d".repeat(64);
    resetAll();
    expect(() => getTreasuryMasterAddress()).toThrow(/mismatch/);
  });

  it("missing TREASURY_MNEMONICS but TREASURY_ENABLED=true throws", () => {
    delete process.env.TREASURY_MNEMONICS;
    resetAll();
    expect(() => getTreasuryMasterAddress()).toThrow(/treasury enabled/);
  });
});

describe("per-user deposit derivation", () => {
  it("rejects index < 1 (reserved for master) or non-integer", () => {
    expect(() => getUserDepositKeypair(0)).toThrow(/derivation index must be integer/);
    expect(() => getUserDepositKeypair(-5)).toThrow(/derivation index must be integer/);
    expect(() => getUserDepositKeypair(1.5)).toThrow(/derivation index must be integer/);
  });

  it("rejects index ≥ 2^31 (SLIP-0010 hardened upper bound)", () => {
    expect(() => getUserDepositKeypair(2_147_483_648)).toThrow(
      /derivation index must be integer in \[1, 2147483648\)/,
    );
  });

  it("derivation is deterministic per (mnemonic, base path, index)", () => {
    const a1 = deriveUserDepositAddress(1);
    const a2 = deriveUserDepositAddress(1);
    expect(a1).toBe(a2);
  });

  it("different indices yield different addresses", () => {
    const a1 = deriveUserDepositAddress(1);
    const a2 = deriveUserDepositAddress(2);
    const a3 = deriveUserDepositAddress(99);
    expect(new Set([a1, a2, a3]).size).toBe(3);
  });

  it("user address differs from master address", () => {
    const master = getTreasuryMasterAddress();
    const user1 = deriveUserDepositAddress(1);
    expect(master).not.toBe(user1);
  });

  it("per-user keypair NOT cached (each call recomputes)", () => {
    const k1 = getUserDepositKeypair(1);
    const k2 = getUserDepositKeypair(1);
    // Different object instances — but same derived address.
    expect(k1).not.toBe(k2);
    expect(k1.toSuiAddress()).toBe(k2.toSuiAddress());
  });

  it("does not derive when only TREASURY_PRIVATE_KEY is set (no mnemonic)", () => {
    delete process.env.TREASURY_MNEMONICS;
    // Use an arbitrary valid suiprivkey so config parses; derivation below should still throw.
    process.env.TREASURY_PRIVATE_KEY =
      "suiprivkey1qpexz0tqjxle6ze2nv5w3gvtrhsa2fl6vz4jv4k9jp0fyscunzu3s6y6r8n";
    resetAll();
    expect(() => deriveUserDepositAddress(1)).toThrow(/requires TREASURY_MNEMONICS/);
  });
});
