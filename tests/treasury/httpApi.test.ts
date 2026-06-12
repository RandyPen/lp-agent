/**
 * Tests for src/treasury/httpApi.ts — Treasury HTTP API v2.
 *
 * Uses real Ed25519Keypair signatures so the full verification path is
 * exercised. A fresh SQLite DB is created in a temp dir for each test.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { openDb, getDb, resetDbCacheForTests } from "../../src/db/client.ts";
import { resetConfigCacheForTests, loadConfig } from "../../src/config.ts";
import { resetTreasuryKeypairCacheForTests } from "../../src/sui/keypairs/treasury.ts";
import { startTreasuryHttpApi } from "../../src/treasury/httpApi.ts";

// ---------------------------------------------------------------------------
// Mnemonics / keypairs
// ---------------------------------------------------------------------------

const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const AGENT_TEST_MNEMONIC =
  "legal winner thank year wave sausage worth useful legal winner thank yellow";

const AGENT_EXPECTED_ADDR = Ed25519Keypair.deriveKeypair(
  AGENT_TEST_MNEMONIC,
  "m/44'/784'/1'/0'/0'",
).toSuiAddress();

// ---------------------------------------------------------------------------
// Env setup
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  "AGENT_PRIVATE_KEY",
  "AGENT_MNEMONICS",
  "MNEMONICS",
  "EXPECTED_AGENT_ADDRESS",
  "IDENTITY_FILES_DISABLED",
  "SUI_USDC_POOL_ID",
  "TREASURY_ENABLED",
  "TREASURY_MNEMONICS",
  "TREASURY_MASTER_DERIVATION_PATH",
  "TREASURY_USER_BASE_PATH",
  "EXPECTED_TREASURY_MASTER_ADDRESS",
  "TREASURY_HTTP_ENABLED",
  "TREASURY_HTTP_HOST",
  "TREASURY_HTTP_PORT",
] as const;

const orig: Record<string, string | undefined> = {};

function snapshotEnv(): void {
  for (const k of ENV_KEYS) orig[k] = process.env[k];
}
function restoreEnv(): void {
  for (const k of ENV_KEYS) {
    if (orig[k] === undefined) delete process.env[k];
    else process.env[k] = orig[k];
  }
}

let tmpDir: string;

function freshAll(): void {
  resetDbCacheForTests();
  resetConfigCacheForTests();
  resetTreasuryKeypairCacheForTests();
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDir = mkdtempSync(join(tmpdir(), "treasury-httpapi-"));
  openDb(join(tmpDir, "test.db"));
}

// ---------------------------------------------------------------------------
// Signing helpers
// ---------------------------------------------------------------------------

async function signMessage(kp: Ed25519Keypair, message: string): Promise<{ messageB64: string; signature: string }> {
  const msgBytes = new TextEncoder().encode(message);
  const { signature } = await kp.signPersonalMessage(msgBytes);
  const messageB64 = btoa(message);
  return { messageB64, signature };
}

function buildRegisterMessage(address: string, timestampMs: number): string {
  return `LiquidityManager:register:${address}:${timestampMs}`;
}

function buildChargeMessage(address: string, credits: number, nonce: string): string {
  return `LiquidityManager:charge:${address}:${credits}:${nonce}`;
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  snapshotEnv();
  for (const k of ENV_KEYS) delete process.env[k];

  process.env.AGENT_MNEMONICS = AGENT_TEST_MNEMONIC;
  process.env.EXPECTED_AGENT_ADDRESS = AGENT_EXPECTED_ADDR;
  process.env.IDENTITY_FILES_DISABLED = "true";
  process.env.SUI_USDC_POOL_ID = "0xpool";
  process.env.TREASURY_ENABLED = "true";
  process.env.TREASURY_MNEMONICS = TEST_MNEMONIC;
  process.env.TREASURY_HTTP_ENABLED = "true";
  process.env.TREASURY_HTTP_HOST = "127.0.0.1";
  process.env.TREASURY_HTTP_PORT = "0";

  freshAll();
});

afterAll(() => {
  restoreEnv();
  resetDbCacheForTests();
  resetConfigCacheForTests();
  resetTreasuryKeypairCacheForTests();
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// Helper: start API for one test and clean up after
// ---------------------------------------------------------------------------

async function withApi<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const cfg = loadConfig();
  const handle = startTreasuryHttpApi(cfg);
  const baseUrl = `http://127.0.0.1:${handle.port}`;
  try {
    return await fn(baseUrl);
  } finally {
    handle.stop();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Treasury HTTP API", () => {
  it("1. register happy path", async () => {
    const kp = new Ed25519Keypair();
    const address = kp.toSuiAddress();
    const now = Date.now();
    const message = buildRegisterMessage(address, now);
    const { messageB64, signature } = await signMessage(kp, message);

    await withApi(async (base) => {
      const res = await fetch(`${base}/v1/users/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suiAddress: address, messageB64, signature }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { suiAddress: string; depositAddress: string; credits: number };
      expect(body.suiAddress).toBe(address);
      expect(body.depositAddress).toMatch(/^0x[0-9a-f]{64}$/);
      expect(body.credits).toBe(0);
    });
  });

  it("2. register wrong-key signature returns 401", async () => {
    const kp = new Ed25519Keypair();
    const wrongKp = new Ed25519Keypair();
    const address = kp.toSuiAddress();
    const now = Date.now();
    const message = buildRegisterMessage(address, now);
    // Sign with wrong key
    const { messageB64, signature } = await signMessage(wrongKp, message);

    await withApi(async (base) => {
      const res = await fetch(`${base}/v1/users/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suiAddress: address, messageB64, signature }),
      });
      expect(res.status).toBe(401);
    });
  });

  it("3. register stale timestamp returns 400", async () => {
    const kp = new Ed25519Keypair();
    const address = kp.toSuiAddress();
    const staleTs = Date.now() - 360_000; // 6 minutes ago
    const message = buildRegisterMessage(address, staleTs);
    const { messageB64, signature } = await signMessage(kp, message);

    await withApi(async (base) => {
      const res = await fetch(`${base}/v1/users/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suiAddress: address, messageB64, signature }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toContain("stale");
    });
  });

  it("4. register malformed message returns 400", async () => {
    const kp = new Ed25519Keypair();
    const address = kp.toSuiAddress();
    const message = "wrong:format";
    const { messageB64, signature } = await signMessage(kp, message);

    await withApi(async (base) => {
      const res = await fetch(`${base}/v1/users/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suiAddress: address, messageB64, signature }),
      });
      expect(res.status).toBe(400);
    });
  });

  it("5. double-register is idempotent (both return 200 with same depositAddress)", async () => {
    const kp = new Ed25519Keypair();
    const address = kp.toSuiAddress();

    await withApi(async (base) => {
      const reg = async () => {
        const now = Date.now();
        const message = buildRegisterMessage(address, now);
        const { messageB64, signature } = await signMessage(kp, message);
        return fetch(`${base}/v1/users/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ suiAddress: address, messageB64, signature }),
        });
      };

      const r1 = await reg();
      const r2 = await reg();
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      const b1 = await r1.json() as { depositAddress: string };
      const b2 = await r2.json() as { depositAddress: string };
      expect(b1.depositAddress).toBe(b2.depositAddress);
    });
  });

  it("6. GET /v1/users/:addr returns user after registration", async () => {
    const kp = new Ed25519Keypair();
    const address = kp.toSuiAddress();

    await withApi(async (base) => {
      // Register first
      const now = Date.now();
      const message = buildRegisterMessage(address, now);
      const { messageB64, signature } = await signMessage(kp, message);
      await fetch(`${base}/v1/users/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suiAddress: address, messageB64, signature }),
      });

      // Then fetch
      const res = await fetch(`${base}/v1/users/${address}`);
      expect(res.status).toBe(200);
      const body = await res.json() as { suiAddress: string; depositAddress: string; credits: number; createdAtMs: number };
      expect(body.suiAddress).toBe(address);
      expect(body.depositAddress).toMatch(/^0x[0-9a-f]{64}$/);
      expect(typeof body.credits).toBe("number");
      expect(typeof body.createdAtMs).toBe("number");
    });
  });

  it("7. GET /v1/users/:addr returns 404 for nonexistent user", async () => {
    const addr = "0x" + "a".repeat(64);
    await withApi(async (base) => {
      const res = await fetch(`${base}/v1/users/${addr}`);
      expect(res.status).toBe(404);
      const body = await res.json() as { error: string };
      expect(body.error).toContain("not found");
    });
  });

  it("8. GET deposits returns array after registration", async () => {
    const kp = new Ed25519Keypair();
    const address = kp.toSuiAddress();

    await withApi(async (base) => {
      const now = Date.now();
      const message = buildRegisterMessage(address, now);
      const { messageB64, signature } = await signMessage(kp, message);
      await fetch(`${base}/v1/users/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suiAddress: address, messageB64, signature }),
      });

      const res = await fetch(`${base}/v1/users/${address}/deposits`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });
  });

  it("9. charge happy path deducts credits and returns remainingCredits", async () => {
    const kp = new Ed25519Keypair();
    const address = kp.toSuiAddress();

    await withApi(async (base) => {
      // Register
      const now = Date.now();
      const message = buildRegisterMessage(address, now);
      const { messageB64: regMsgB64, signature: regSig } = await signMessage(kp, message);
      await fetch(`${base}/v1/users/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suiAddress: address, messageB64: regMsgB64, signature: regSig }),
      });

      // Add credits via direct DB
      getDb()
        .prepare("UPDATE treasury_users SET credits = ? WHERE sui_address = ?")
        .run(1000, address);

      // Charge
      const credits = 100;
      const nonce = "test-nonce-happy-1";
      const chargeMsg = buildChargeMessage(address, credits, nonce);
      const { messageB64, signature } = await signMessage(kp, chargeMsg);

      const res = await fetch(`${base}/v1/charges`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suiAddress: address, credits, nonce, messageB64, signature }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean; remainingCredits: number };
      expect(body.ok).toBe(true);
      expect(body.remainingCredits).toBe(900);
    });
  });

  it("10. tampered credits (message says 5, body says 10) returns 400", async () => {
    const kp = new Ed25519Keypair();
    const address = kp.toSuiAddress();

    await withApi(async (base) => {
      // Register
      const now = Date.now();
      const regMessage = buildRegisterMessage(address, now);
      const { messageB64: regB64, signature: regSig } = await signMessage(kp, regMessage);
      await fetch(`${base}/v1/users/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suiAddress: address, messageB64: regB64, signature: regSig }),
      });

      getDb()
        .prepare("UPDATE treasury_users SET credits = ? WHERE sui_address = ?")
        .run(1000, address);

      // Sign message with credits=5, but send body with credits=10
      const nonce = "tampered-nonce-1";
      const chargeMsg = buildChargeMessage(address, 5, nonce); // signed for 5
      const { messageB64, signature } = await signMessage(kp, chargeMsg);

      const res = await fetch(`${base}/v1/charges`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suiAddress: address, credits: 10, nonce, messageB64, signature }),
      });
      expect(res.status).toBe(400);
    });
  });

  it("11. charge replay (same nonce) is idempotent — credits deducted only once", async () => {
    const kp = new Ed25519Keypair();
    const address = kp.toSuiAddress();

    await withApi(async (base) => {
      // Register
      const now = Date.now();
      const regMessage = buildRegisterMessage(address, now);
      const { messageB64: regB64, signature: regSig } = await signMessage(kp, regMessage);
      await fetch(`${base}/v1/users/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suiAddress: address, messageB64: regB64, signature: regSig }),
      });

      getDb()
        .prepare("UPDATE treasury_users SET credits = ? WHERE sui_address = ?")
        .run(1000, address);

      const credits = 50;
      const nonce = "replay-nonce-1";
      const chargeMsg = buildChargeMessage(address, credits, nonce);
      const { messageB64, signature } = await signMessage(kp, chargeMsg);

      const payload = JSON.stringify({ suiAddress: address, credits, nonce, messageB64, signature });

      // First call
      const r1 = await fetch(`${base}/v1/charges`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
      });
      expect(r1.status).toBe(200);
      const b1 = await r1.json() as { ok: boolean; remainingCredits: number };
      expect(b1.ok).toBe(true);
      expect(b1.remainingCredits).toBe(950);

      // Second call with same nonce — idempotent
      const r2 = await fetch(`${base}/v1/charges`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
      });
      expect(r2.status).toBe(200);
      const b2 = await r2.json() as { ok: boolean; remainingCredits: number };
      expect(b2.ok).toBe(true);

      // Verify credits only deducted once
      const userRow = getDb()
        .query<{ credits: number }, [string]>(
          "SELECT credits FROM treasury_users WHERE sui_address = ?",
        )
        .get(address);
      expect(userRow?.credits).toBe(950);
    });
  });

  it("12. insufficient credits returns 402", async () => {
    const kp = new Ed25519Keypair();
    const address = kp.toSuiAddress();

    await withApi(async (base) => {
      // Register (0 credits, no top-up)
      const now = Date.now();
      const regMessage = buildRegisterMessage(address, now);
      const { messageB64: regB64, signature: regSig } = await signMessage(kp, regMessage);
      await fetch(`${base}/v1/users/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suiAddress: address, messageB64: regB64, signature: regSig }),
      });

      const credits = 100;
      const nonce = "insufficient-nonce-1";
      const chargeMsg = buildChargeMessage(address, credits, nonce);
      const { messageB64, signature } = await signMessage(kp, chargeMsg);

      const res = await fetch(`${base}/v1/charges`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suiAddress: address, credits, nonce, messageB64, signature }),
      });
      expect(res.status).toBe(402);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("insufficient_credits");
    });
  });

  it("13. nonce-first audit: bad sig produces rejected nonce row in DB", async () => {
    const kp = new Ed25519Keypair();
    const wrongKp = new Ed25519Keypair();
    const address = kp.toSuiAddress();

    await withApi(async (base) => {
      // Register
      const now = Date.now();
      const regMessage = buildRegisterMessage(address, now);
      const { messageB64: regB64, signature: regSig } = await signMessage(kp, regMessage);
      await fetch(`${base}/v1/users/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suiAddress: address, messageB64: regB64, signature: regSig }),
      });

      getDb()
        .prepare("UPDATE treasury_users SET credits = ? WHERE sui_address = ?")
        .run(1000, address);

      const credits = 50;
      const nonce = "bad-sig-nonce-1";
      const chargeMsg = buildChargeMessage(address, credits, nonce);
      // Sign with correct message format but WRONG key
      const { messageB64, signature: badSig } = await signMessage(wrongKp, chargeMsg);

      const res = await fetch(`${base}/v1/charges`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suiAddress: address, credits, nonce, messageB64, signature: badSig }),
      });
      expect(res.status).toBe(401);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("bad_signature");

      // Verify nonce row exists with status='rejected' and error='bad_signature'
      const nonceRow = getDb()
        .query<{ status: string; error: string | null }, [string, string]>(
          "SELECT status, error FROM treasury_charge_nonces WHERE sui_address = ? AND nonce = ?",
        )
        .get(address, nonce);

      expect(nonceRow).not.toBeNull();
      expect(nonceRow?.status).toBe("rejected");
      expect(nonceRow?.error).toBe("bad_signature");
    });
  });
});
