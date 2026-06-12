/**
 * Tests for the agent singleton wrapper (src/sui/keypairs/agent.ts) and the
 * config-layer env mapping. Verifies the cache + the AGENT_MNEMONICS ↔
 * MNEMONICS alias precedence.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { resetConfigCacheForTests } from "../src/config.ts";
import {
  getAgentAddress,
  getAgentKeypair,
  resetAgentKeypairCacheForTests,
} from "../src/sui/keypairs/agent.ts";

const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const ADDR_PATH1 =
  "0x082d099250999ab8450a9ef3a962edf9e2449e1045be32ba5a0f2c6117ff7167";
const SUIPRIVKEY_PATH1 =
  "suiprivkey1qpexz0tqjxle6ze2nv5w3gvtrhsa2fl6vz4jv4k9jp0fyscunzu3s6y6r8n";
// Derived once at module load — used by tests that override AGENT_DERIVATION_PATH.
const ADDR_PATH0 = Ed25519Keypair.deriveKeypair(
  TEST_MNEMONIC,
  "m/44'/784'/0'/0'/0'",
).toSuiAddress();

const ENV_KEYS = [
  "AGENT_PRIVATE_KEY",
  "AGENT_MNEMONICS",
  "MNEMONICS",
  "AGENT_DERIVATION_PATH",
  "EXPECTED_AGENT_ADDRESS",
  "AGENT_IDENTITY_FILE",
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
  resetAgentKeypairCacheForTests();
}

beforeEach(() => {
  snapshot();
  for (const k of ENV_KEYS) delete process.env[k];
  // Pool profile loader needs this; unrelated to keys.
  process.env.SUI_USDC_POOL_ID = "0xpool";
  // EXPECTED_AGENT_ADDRESS is required by loadConfig; default to the
  // path-1 derived address so the typical "good path" cases pass without
  // each test having to set it. Tests that exercise mismatch / wrong-path
  // behaviour override this inside the test body.
  process.env.EXPECTED_AGENT_ADDRESS = ADDR_PATH1;
  // Each test rotates mnemonics/private keys — TOFU identity file would clash
  // across tests, so disable persistence here. Identity-file behaviour itself
  // is exercised by tests/identityFile.test.ts.
  process.env.IDENTITY_FILES_DISABLED = "true";
  resetAll();
});

afterAll(() => {
  restore();
  resetAll();
});

describe("agent singleton — private key path", () => {
  it("derives via AGENT_PRIVATE_KEY", () => {
    process.env.AGENT_PRIVATE_KEY = SUIPRIVKEY_PATH1;
    resetAll();
    expect(getAgentAddress()).toBe(ADDR_PATH1);
  });
});

describe("agent singleton — mnemonic path with both alias names", () => {
  it("AGENT_MNEMONICS works (preferred name)", () => {
    process.env.AGENT_MNEMONICS = TEST_MNEMONIC;
    resetAll();
    expect(getAgentAddress()).toBe(ADDR_PATH1);
  });

  it("MNEMONICS works (legacy alias)", () => {
    process.env.MNEMONICS = TEST_MNEMONIC;
    resetAll();
    expect(getAgentAddress()).toBe(ADDR_PATH1);
  });

  it("AGENT_MNEMONICS wins over MNEMONICS when both set", () => {
    // Set AGENT_MNEMONICS to the right phrase; set MNEMONICS to a different
    // phrase that would derive a different address. The right one wins.
    process.env.AGENT_MNEMONICS = TEST_MNEMONIC;
    process.env.MNEMONICS =
      "legal winner thank year wave sausage worth useful legal winner thank yellow";
    resetAll();
    expect(getAgentAddress()).toBe(ADDR_PATH1);
  });

  it("honours AGENT_DERIVATION_PATH override", () => {
    process.env.MNEMONICS = TEST_MNEMONIC;
    process.env.AGENT_DERIVATION_PATH = "m/44'/784'/0'/0'/0'";
    // EXPECTED must match the new path's derived address, not the default.
    process.env.EXPECTED_AGENT_ADDRESS = ADDR_PATH0;
    resetAll();
    const addr0 = getAgentAddress();
    expect(addr0).toBe(ADDR_PATH0);
    expect(addr0).not.toBe(ADDR_PATH1);
  });
});

describe("agent singleton — cache + reset", () => {
  it("subsequent calls return the same keypair instance", () => {
    process.env.MNEMONICS = TEST_MNEMONIC;
    resetAll();
    const a = getAgentKeypair();
    const b = getAgentKeypair();
    expect(a).toBe(b);
  });

  it("resetAgentKeypairCacheForTests clears the singleton", () => {
    process.env.MNEMONICS = TEST_MNEMONIC;
    resetAll();
    const a = getAgentKeypair();
    resetAgentKeypairCacheForTests();
    const b = getAgentKeypair();
    expect(a).not.toBe(b);
    expect(a.toSuiAddress()).toBe(b.toSuiAddress());
  });
});

describe("agent singleton — guard + missing config", () => {
  it("EXPECTED_AGENT_ADDRESS match passes", () => {
    process.env.MNEMONICS = TEST_MNEMONIC;
    process.env.EXPECTED_AGENT_ADDRESS = ADDR_PATH1;
    resetAll();
    expect(getAgentAddress()).toBe(ADDR_PATH1);
  });

  it("EXPECTED_AGENT_ADDRESS mismatch throws", () => {
    process.env.MNEMONICS = TEST_MNEMONIC;
    // Properly formatted (64-hex) but wrong address — passes the
    // config-level format check, fails at resolveKeypair.
    process.env.EXPECTED_AGENT_ADDRESS = "0x" + "d".repeat(64);
    resetAll();
    expect(() => getAgentAddress()).toThrow(/address mismatch/);
  });

  it("malformed EXPECTED_AGENT_ADDRESS aborts at loadConfig", () => {
    process.env.MNEMONICS = TEST_MNEMONIC;
    process.env.EXPECTED_AGENT_ADDRESS = "0xdeadbeef"; // too short
    resetAll();
    expect(() => getAgentAddress()).toThrow(/EXPECTED_AGENT_ADDRESS malformed/);
  });

  it("missing EXPECTED_AGENT_ADDRESS aborts at loadConfig", () => {
    process.env.MNEMONICS = TEST_MNEMONIC;
    delete process.env.EXPECTED_AGENT_ADDRESS;
    resetAll();
    expect(() => getAgentAddress()).toThrow(/EXPECTED_AGENT_ADDRESS not set/);
  });

  it("missing both AGENT_PRIVATE_KEY and any mnemonic throws at loadConfig", () => {
    // Note: beforeEach sets EXPECTED_AGENT_ADDRESS for us, so the only
    // missing piece here is the key source.
    resetAll();
    expect(() => getAgentAddress()).toThrow(/agent key not configured/);
  });
});
