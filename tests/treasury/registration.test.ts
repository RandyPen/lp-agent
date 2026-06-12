/**
 * Tests for src/treasury/registration.ts — the thin wrapper that combines
 * `registerUserTx` (store) + `deriveUserDepositAddress` (keypair).
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { openDb, resetDbCacheForTests } from "../../src/db/client.ts";
import { resetConfigCacheForTests } from "../../src/config.ts";
import { resetTreasuryKeypairCacheForTests } from "../../src/sui/keypairs/treasury.ts";
import { registerUser } from "../../src/treasury/registration.ts";
import { listUsers, findUserBySuiAddress } from "../../src/treasury/store.ts";

const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
// EXPECTED_AGENT_ADDRESS is required by loadConfig — pre-compute the address
// the test agent mnemonic resolves to.
const AGENT_EXPECTED_ADDR = Ed25519Keypair.deriveKeypair(
  TEST_MNEMONIC,
  "m/44'/784'/1'/0'/0'",
).toSuiAddress();

const ENV_KEYS = [
  "AGENT_PRIVATE_KEY",
  "AGENT_MNEMONICS",
  "MNEMONICS",
  "EXPECTED_AGENT_ADDRESS",
  "IDENTITY_FILES_DISABLED",
  "TREASURY_ENABLED",
  "TREASURY_MNEMONICS",
  "TREASURY_MASTER_DERIVATION_PATH",
  "TREASURY_USER_BASE_PATH",
  "EXPECTED_TREASURY_MASTER_ADDRESS",
  "SUI_USDC_POOL_ID",
] as const;
const orig: Record<string, string | undefined> = {};

let tmpDir: string;

function snapshot(): void {
  for (const k of ENV_KEYS) orig[k] = process.env[k];
}
function restore(): void {
  for (const k of ENV_KEYS) {
    if (orig[k] === undefined) delete process.env[k];
    else process.env[k] = orig[k];
  }
}
function freshAll(): void {
  resetDbCacheForTests();
  resetConfigCacheForTests();
  resetTreasuryKeypairCacheForTests();
  if (tmpDir) { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } }
  tmpDir = mkdtempSync(join(tmpdir(), "treasury-reg-"));
  openDb(join(tmpDir, "test.db"));
}

beforeEach(() => {
  snapshot();
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.AGENT_MNEMONICS = TEST_MNEMONIC; // satisfies loadConfig
  process.env.EXPECTED_AGENT_ADDRESS = AGENT_EXPECTED_ADDR;
  process.env.IDENTITY_FILES_DISABLED = "true";
  process.env.SUI_USDC_POOL_ID = "0xpool";
  process.env.TREASURY_ENABLED = "true";
  process.env.TREASURY_MNEMONICS = TEST_MNEMONIC;
  freshAll();
});

afterAll(() => {
  restore();
  resetDbCacheForTests();
  resetConfigCacheForTests();
  resetTreasuryKeypairCacheForTests();
  if (tmpDir) { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } }
});

describe("registerUser", () => {
  it("creates a user with derivation_index=1 + valid 0x deposit address", () => {
    const u = registerUser("0x" + "a".repeat(64));
    expect(u.derivationIndex).toBe(1);
    expect(u.depositAddress).toMatch(/^0x[0-9a-f]{64}$/);
    expect(u.credits).toBe(0);
  });

  it("idempotent: re-registering returns existing user, no second row", () => {
    const u1 = registerUser("0x" + "a".repeat(64));
    const u2 = registerUser("0x" + "a".repeat(64));
    expect(u2.derivationIndex).toBe(u1.derivationIndex);
    expect(u2.depositAddress).toBe(u1.depositAddress);
    expect(listUsers()).toHaveLength(1);
  });

  it("two different users get distinct indices + addresses", () => {
    const a = registerUser("0x" + "a".repeat(64));
    const b = registerUser("0x" + "b".repeat(64));
    expect(b.derivationIndex).toBe(a.derivationIndex + 1);
    expect(b.depositAddress).not.toBe(a.depositAddress);
  });

  it("rejects malformed sui addresses", () => {
    expect(() => registerUser("not_an_address")).toThrow(/invalid sui address/);
    expect(() => registerUser("")).toThrow();
  });

  it("trims surrounding whitespace", () => {
    const u = registerUser("  0x" + "a".repeat(64) + "  ");
    expect(u.suiAddress).toBe("0x" + "a".repeat(64));
    expect(findUserBySuiAddress("0x" + "a".repeat(64))).not.toBeNull();
  });
});
