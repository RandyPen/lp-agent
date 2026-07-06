/**
 * tests/services/rebalancerLifecycle.test.ts
 *
 * Fix 3 (startup reconciliation) + Fix 4 (drain-before-exit) from
 * src/services/rebalancer.ts.
 *
 * Fix 3's `reconcileOrphanedRebalances` is pure DB logic (plus the already-
 * tested `refundCharge` seam) — exercised directly against a real schema.
 *
 * Fix 4's `drain()` needs a real `RebalancerService`, but `tickOne` pulls in
 * live Sui RPC clients (CDPM reads, pool state) that are impractical to spin
 * up in a unit test — see tests/treasury/rebalancerCharges.test.ts's header
 * comment for the same tradeoff. We exercise the REAL `tickOne` end-to-end
 * over its cheapest possible path (the authorization-check early return —
 * `isAgentAuthorized` is mocked at the module boundary to resolve after an
 * artificial delay we control) so `drain()` is exercised against a genuine
 * in-flight promise, not a hand-rolled stand-in for the drain mechanism.
 */

import { describe, it, expect, beforeEach, afterAll, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Module mocks — only the chain-touching seam `tickOne` needs to reach before
// its authorization-check early return. Everything else (executor, price
// feed, subscriptions, risk monitor) is injected as plain fakes below.
// ---------------------------------------------------------------------------

let authorizedResolvers: Array<() => void> = [];
let authorizedResult = false;

mock.module("../../src/sui/cdpm/read.ts", () => ({
  getPositionManager: async () => {
    throw new Error("getPositionManager should not be reached in this test");
  },
  isAgentAuthorized: () =>
    new Promise<boolean>((resolve) => {
      authorizedResolvers.push(() => resolve(authorizedResult));
    }),
}));

mock.module("../../src/sui/pool.ts", () => ({
  getPoolState: async () => {
    throw new Error("getPoolState should not be reached in this test");
  },
}));

const { openDb, resetDbCacheForTests, getDb } = await import("../../src/db/client.ts");
const { loadConfig, resetConfigCacheForTests } = await import("../../src/config.ts");
const { resetKeypairCacheForTests } = await import("../../src/sui/keypair.ts");
const { createRiskMonitor } = await import("../../src/risk/monitor.ts");
const { createRebalancerService, reconcileOrphanedRebalances } =
  await import("../../src/services/rebalancer.ts");
const { registerUserTx, upsertCreditRate, findUserBySuiAddress } =
  await import("../../src/treasury/store.ts");
const { attemptCharge } = await import("../../src/treasury/charges.ts");
const { canonicalType } = await import("../../src/sui/lending/typeNorm.ts");
import type { SubscriptionsService } from "../../src/services/subscriptions.ts";
import type { ExecutorService } from "../../src/services/executor.ts";
import type { PriceFeed } from "../../src/data/priceFeed.ts";
import type { Subscription } from "../../src/domain/types.ts";

// ---------------------------------------------------------------------------
// Env + DB lifecycle
// ---------------------------------------------------------------------------

const REQUIRED_ENV: Record<string, string> = {
  AGENT_PRIVATE_KEY: "suiprivkey1qr3twlseqm4qj5sr7mqhz3yyx7wrluu3qn39nj6jxpsxufe46mul574lteq",
  SUI_USDC_POOL_ID: "0xpool",
  EXPECTED_AGENT_ADDRESS: "",
  IDENTITY_FILES_DISABLED: "true",
  LENDING_ENABLED: "false",
  TREASURY_ENABLED: "false",
  ML_SHADOW_MODE: "false",
  REBALANCE_INTERVAL_MS: "10",
};
const origEnv: Record<string, string | undefined> = {};
let tmpDir: string;

beforeEach(async () => {
  const { decodeSuiPrivateKey } = await import("@mysten/sui/cryptography");
  const { Ed25519Keypair } = await import("@mysten/sui/keypairs/ed25519");
  const { secretKey } = decodeSuiPrivateKey(REQUIRED_ENV.AGENT_PRIVATE_KEY!);
  REQUIRED_ENV.EXPECTED_AGENT_ADDRESS = Ed25519Keypair.fromSecretKey(secretKey).toSuiAddress();
  for (const [k, v] of Object.entries(REQUIRED_ENV)) {
    origEnv[k] = process.env[k];
    process.env[k] = v;
  }
  resetConfigCacheForTests();
  resetKeypairCacheForTests();

  resetDbCacheForTests();
  tmpDir = mkdtempSync(join(tmpdir(), "rebalancer-lifecycle-"));
  openDb(join(tmpDir, "test.db"));

  authorizedResolvers = [];
  authorizedResult = false;
});

afterEach(() => {
  for (const k of Object.keys(REQUIRED_ENV)) {
    if (origEnv[k] !== undefined) process.env[k] = origEnv[k];
    else delete process.env[k];
  }
  resetConfigCacheForTests();
});

afterAll(() => {
  resetDbCacheForTests();
  if (tmpDir) { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } }
});

// ---------------------------------------------------------------------------
// Fix 3 — reconcileOrphanedRebalances
// ---------------------------------------------------------------------------

const OWNER = "0x" + "a".repeat(64);
const PM_ID = "0x" + "f".repeat(64);
const USDC = canonicalType(
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
);

describe("reconcileOrphanedRebalances", () => {
  it("refunds the charge and marks an orphaned 'planned' row terminal", () => {
    const db = getDb();
    registerUserTx(OWNER, () => "0xdep_1");
    upsertCreditRate({ coinType: USDC, rateNum: 1n, rateDen: 1n });
    // Seed credits directly via a deposit-shaped row through the store so
    // attemptCharge below has something to debit.
    db.prepare(
      `UPDATE treasury_users SET credits = 500 WHERE sui_address = ?`,
    ).run(OWNER);

    const nonce = "tOrphan:" + PM_ID;
    const charge = attemptCharge({ suiAddress: OWNER, pmId: PM_ID, cost: 50, nonce, memo: null });
    expect(charge.ok).toBe(true);
    expect(findUserBySuiAddress(OWNER)?.credits).toBe(450);

    // Simulate the crash: a 'planned' rebalances row with this charge_nonce,
    // never reaching the final status UPDATE.
    db.prepare(
      `INSERT INTO rebalances (pm_id, planned_at_ms, plan_json, status, charge_nonce)
       VALUES (?, ?, '{}', 'planned', ?)`,
    ).run(PM_ID, Date.now(), nonce);

    const result = reconcileOrphanedRebalances(db);
    expect(result.scanned).toBe(1);
    expect(result.refunded).toBe(1);

    // Charge refunded — user made whole.
    expect(findUserBySuiAddress(OWNER)?.credits).toBe(500);

    // Row marked terminal ('failed' — see the function's schema-constraint
    // doc comment for why not a new 'abandoned' enum value) and no longer
    // shows up on a second sweep.
    const row = db
      .query<{ status: string; error: string | null }, [string]>(
        `SELECT status, error FROM rebalances WHERE pm_id = ?`,
      )
      .get(PM_ID);
    expect(row?.status).toBe("failed");
    expect(row?.error).toMatch(/abandoned/);

    const second = reconcileOrphanedRebalances(db);
    expect(second.scanned).toBe(0);
  });

  it("leaves succeeded/failed rows alone (no double-refund, no re-sweep)", () => {
    const db = getDb();
    registerUserTx(OWNER, () => "0xdep_1");
    db.prepare(`UPDATE treasury_users SET credits = 500 WHERE sui_address = ?`).run(OWNER);
    db.prepare(
      `INSERT INTO rebalances (pm_id, planned_at_ms, plan_json, status, charge_nonce)
       VALUES (?, ?, '{}', 'succeeded', NULL)`,
    ).run(PM_ID, Date.now());

    const result = reconcileOrphanedRebalances(db);
    expect(result.scanned).toBe(0);
    expect(findUserBySuiAddress(OWNER)?.credits).toBe(500);
  });

  it("sweeps a row with no charge_nonce (treasury disabled) without attempting a refund", () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO rebalances (pm_id, planned_at_ms, plan_json, status, charge_nonce)
       VALUES (?, ?, '{}', 'planned', NULL)`,
    ).run(PM_ID, Date.now());

    const result = reconcileOrphanedRebalances(db);
    expect(result.scanned).toBe(1);
    expect(result.refunded).toBe(0);
    const row = db
      .query<{ status: string }, [string]>(`SELECT status FROM rebalances WHERE pm_id = ?`)
      .get(PM_ID);
    expect(row?.status).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// Fix 4 — drain()
// ---------------------------------------------------------------------------

const unusedExecutor: ExecutorService = {
  collectAndTransferFees: async () => { throw new Error("unused"); },
  removeLiquidity: async () => { throw new Error("unused"); },
  addLiquidity: async () => { throw new Error("unused"); },
  supplyToLending: async () => { throw new Error("unused"); },
  redeemFromLending: async () => { throw new Error("unused"); },
  submitUnifiedRebalance: async () => { throw new Error("unused"); },
  estimateRemoveProceeds: async () => { throw new Error("unused"); },
};

const unusedPriceFeed: PriceFeed = {
  source: "test",
  getSpot: async () => { throw new Error("unused"); },
  getHistory: async () => { throw new Error("unused"); },
  getOhlcv: async () => { throw new Error("unused"); },
};

function fakeSubscriptions(sub: Subscription): SubscriptionsService {
  return {
    pollOnce: async () => ({ added: 0, removed: 0, closed: 0 }),
    listActive: () => [sub],
    get: (pmId: string) => (pmId === sub.pmId ? sub : null),
  };
}

describe("rebalancer drain()", () => {
  it("drain() resolves only after the in-flight tick (real tickOne, real early-return path) settles", async () => {
    const db = getDb();
    const sub: Subscription = {
      pmId: PM_ID,
      owner: OWNER,
      poolId: "0xpool",
      coinTypeA: "0x2::sui::SUI",
      coinTypeB: USDC,
      status: "active",
      addedAtMs: Date.now(),
      removedAtMs: null,
    };
    db.prepare(
      `INSERT INTO subscriptions (pm_id, owner, pool_id, coin_type_a, coin_type_b, status, added_at_ms)
       VALUES (?, ?, ?, ?, ?, 'active', ?)`,
    ).run(sub.pmId, sub.owner, sub.poolId, sub.coinTypeA, sub.coinTypeB, sub.addedAtMs);

    const cfg = loadConfig();
    const riskMonitor = createRiskMonitor({
      db,
      thresholds: cfg.risk.thresholds,
      l3: cfg.risk.l3,
    });

    const rebalancer = createRebalancerService(
      fakeSubscriptions(sub),
      unusedExecutor,
      unusedPriceFeed,
      { riskMonitor, liveStrategyName: "singleBin" },
    );

    const stop = rebalancer.start();
    try {
      // Give the interval a tick to fire tickOne(sub.pmId), which awaits our
      // mocked (still-pending) isAgentAuthorized().
      await new Promise((r) => setTimeout(r, 20));
      expect(authorizedResolvers.length).toBeGreaterThan(0);

      let drained = false;
      const drainPromise = rebalancer.drain().then(() => {
        drained = true;
      });

      // drain() must NOT resolve while the tick is still awaiting authorization.
      await new Promise((r) => setTimeout(r, 20));
      expect(drained).toBe(false);

      // Release the pending isAgentAuthorized() call (returns false -> tickOne
      // takes its early-return path and deletes the subscription row).
      authorizedResult = false;
      for (const resolve of authorizedResolvers) resolve();

      await drainPromise;
      expect(drained).toBe(true);

      const remaining = db
        .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM subscriptions WHERE pm_id = ?`)
        .get(sub.pmId);
      expect(remaining?.n).toBe(0);
    } finally {
      stop();
    }
  });
});
