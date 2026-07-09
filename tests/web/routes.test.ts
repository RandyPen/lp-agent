/**
 * Tests for src/web/routes.ts — read-only web API routes mounted into the
 * treasury HTTP server. A fresh SQLite DB is created in a temp dir per test;
 * rows are seeded directly through the db client.
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

const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const AGENT_TEST_MNEMONIC =
  "legal winner thank year wave sausage worth useful legal winner thank yellow";
const AGENT_EXPECTED_ADDR = Ed25519Keypair.deriveKeypair(
  AGENT_TEST_MNEMONIC,
  "m/44'/784'/1'/0'/0'",
).toSuiAddress();

const POOL_ID = "0xpool";
const PM_A = `0x${"ab".repeat(32)}`;
const PM_B = `0x${"cd".repeat(32)}`;
const OWNER_1 = `0x${"11".repeat(32)}`;
const OWNER_2 = `0x${"22".repeat(32)}`;

const ENV_KEYS = [
  "AGENT_PRIVATE_KEY",
  "AGENT_MNEMONICS",
  "MNEMONICS",
  "EXPECTED_AGENT_ADDRESS",
  "IDENTITY_FILES_DISABLED",
  "SUI_USDC_POOL_ID",
  "TREASURY_ENABLED",
  "TREASURY_MNEMONICS",
  "TREASURY_HTTP_ENABLED",
  "TREASURY_HTTP_HOST",
  "TREASURY_HTTP_PORT",
] as const;

const orig: Record<string, string | undefined> = {};
let tmpDir: string;

beforeEach(() => {
  for (const k of ENV_KEYS) orig[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];

  process.env.AGENT_MNEMONICS = AGENT_TEST_MNEMONIC;
  process.env.EXPECTED_AGENT_ADDRESS = AGENT_EXPECTED_ADDR;
  process.env.IDENTITY_FILES_DISABLED = "true";
  process.env.SUI_USDC_POOL_ID = POOL_ID;
  process.env.TREASURY_ENABLED = "true";
  process.env.TREASURY_MNEMONICS = TEST_MNEMONIC;
  process.env.TREASURY_HTTP_ENABLED = "true";
  process.env.TREASURY_HTTP_HOST = "127.0.0.1";
  process.env.TREASURY_HTTP_PORT = "0";

  resetDbCacheForTests();
  resetConfigCacheForTests();
  resetTreasuryKeypairCacheForTests();
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDir = mkdtempSync(join(tmpdir(), "web-routes-"));
  openDb(join(tmpDir, "test.db"));
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (orig[k] === undefined) delete process.env[k];
    else process.env[k] = orig[k];
  }
  resetDbCacheForTests();
  resetConfigCacheForTests();
  resetTreasuryKeypairCacheForTests();
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

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
// Seed helpers
// ---------------------------------------------------------------------------

function seedSubscription(pmId: string, owner: string, addedAtMs: number): void {
  getDb()
    .prepare(
      "INSERT INTO subscriptions (pm_id, owner, pool_id, coin_type_a, coin_type_b, status, added_at_ms) VALUES (?, ?, ?, 'coinA', 'coinB', 'active', ?)",
    )
    .run(pmId, owner, POOL_ID, addedAtMs);
}

function seedRebalance(pmId: string, plannedAtMs: number, status: string): void {
  const plan = {
    pmId,
    removeShares: { "100": "5000" },
    addAmountA: "1000000",
    addAmountB: "2000000",
    addBins: [101, 102, 103],
    addAmountsA: ["0", "0", "1000000"],
    addAmountsB: ["1000000", "1000000", "0"],
    collectFees: true,
    reason: "recenter",
    plannedActiveBinId: 102,
  };
  getDb()
    .prepare(
      "INSERT INTO rebalances (pm_id, planned_at_ms, submitted_at_ms, digest, plan_json, status) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(pmId, plannedAtMs, plannedAtMs + 1000, `digest-${plannedAtMs}`, JSON.stringify(plan), status);
}

function seedPnlTick(pmId: string, tsMs: number, navUsd: number): void {
  getDb()
    .prepare(
      "INSERT INTO pnl_ticks (pool_id, pm_id, ts_ms, fee_income_usd, cost_credits, inventory_delta_usd, il_usd, nav_usd, market_state) VALUES (?, ?, ?, 0.5, 10, 0.0, -0.1, ?, 'NORMAL')",
    )
    .run(POOL_ID, pmId, tsMs, navUsd);
}

function seedPrediction(tsMs: number): void {
  getDb()
    .prepare(
      "INSERT INTO predictions (pool_id, ts_ms, model_version, active_bin, center_q10, center_offset, center_q90, width_sigma, p_above, p_below, feature_completeness, psi, fallback, executed_path, infer_ms) VALUES (?, ?, 'v1.0', 100, -2.0, 0.5, 3.0, 1.2, 0.4, 0.3, 1.0, 0.05, NULL, 'model', 12)",
    )
    .run(POOL_ID, tsMs);
}

function seedPrice(observedMs: number, price: string): void {
  getDb()
    .prepare(
      "INSERT INTO price_observations (pool_id, source, price, observed_ms) VALUES (?, 'binance', ?, ?)",
    )
    .run(POOL_ID, price, observedMs);
}

function seedRiskEvent(tsMs: number, source: "live" | "shadow"): void {
  getDb()
    .prepare(
      "INSERT INTO risk_events (pool_id, pm_id, ts_ms, level, kind, metric, threshold, observed, action, source) VALUES (?, ?, ?, 'L2', 'daily_loss', 'pnl_24h_pct', -5.0, -6.2, 'pause', ?)",
    )
    .run(POOL_ID, PM_A, tsMs, source);
}

function seedShadowDecision(tsMs: number): void {
  getDb()
    .prepare(
      "INSERT INTO shadow_decisions (pool_id, pm_id, ts_ms, market_state, strategy_output_kind, strategy_output_json, rule_output_kind, rule_output_json, lending_pct, half_width, trend_bias, model_version, active_bin, spot_price, created_at_ms) VALUES (?, ?, ?, 'NORMAL', 'plan_and_reconcile', '{}', 'quiet', '{}', 0.2, 5, 0.1, 'v1.0', 100, '3.42', ?)",
    )
    .run(POOL_ID, PM_A, tsMs, tsMs);
}

function seedMarketState(enteredAtMs: number, state: string): void {
  getDb()
    .prepare(
      "INSERT INTO market_state_history (pool_id, entered_at_ms, state, trigger, prev_state) VALUES (?, ?, ?, 'sigma_jump', 'NORMAL')",
    )
    .run(POOL_ID, enteredAtMs, state);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("web routes: /v1/agent/summary", () => {
  it("returns agent identity, pool profile, and counts", async () => {
    seedSubscription(PM_A, OWNER_1, 1000);
    seedSubscription(PM_B, OWNER_2, 2000);
    seedRebalance(PM_A, 5000, "succeeded");
    seedPrediction(6000);

    await withApi(async (base) => {
      const res = await fetch(`${base}/v1/agent/summary`);
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.agentAddress).toBe(AGENT_EXPECTED_ADDR);
      expect((body.pool as Record<string, unknown>).poolId).toBe(POOL_ID);
      expect(body.activePms).toBe(2);
      expect(body.succeededRebalances).toBe(1);
      expect(body.lastRebalanceMs).toBe(6000);
      expect(body.modelVersion).toBe("v1.0");
      expect(typeof body.cdpmPackage).toBe("string");
    });
  });
});

describe("web routes: /v1/pms", () => {
  it("lists all subscriptions, newest first", async () => {
    seedSubscription(PM_A, OWNER_1, 1000);
    seedSubscription(PM_B, OWNER_2, 2000);

    await withApi(async (base) => {
      const res = await fetch(`${base}/v1/pms`);
      expect(res.status).toBe(200);
      const rows = await res.json() as Array<{ pm_id: string }>;
      expect(rows.length).toBe(2);
      expect(rows[0]!.pm_id).toBe(PM_B);
    });
  });

  it("filters by owner", async () => {
    seedSubscription(PM_A, OWNER_1, 1000);
    seedSubscription(PM_B, OWNER_2, 2000);

    await withApi(async (base) => {
      const res = await fetch(`${base}/v1/pms?owner=${OWNER_1}`);
      const rows = await res.json() as Array<{ pm_id: string; owner: string }>;
      expect(rows.length).toBe(1);
      expect(rows[0]!.owner).toBe(OWNER_1);
    });
  });

  it("rejects malformed owner", async () => {
    await withApi(async (base) => {
      const res = await fetch(`${base}/v1/pms?owner=nothex`);
      expect(res.status).toBe(400);
    });
  });
});

describe("web routes: /v1/pms/:pmId/rebalances", () => {
  it("404 for unknown pm", async () => {
    await withApi(async (base) => {
      const res = await fetch(`${base}/v1/pms/${PM_A}/rebalances`);
      expect(res.status).toBe(404);
    });
  });

  it("returns rows newest-first with parsed plan summary", async () => {
    seedSubscription(PM_A, OWNER_1, 1000);
    seedRebalance(PM_A, 5000, "succeeded");
    seedRebalance(PM_A, 7000, "failed");

    await withApi(async (base) => {
      const res = await fetch(`${base}/v1/pms/${PM_A}/rebalances`);
      expect(res.status).toBe(200);
      const rows = await res.json() as Array<{
        plannedAtMs: number;
        status: string;
        summary: { addBinCount: number; removeBinCount: number; reason: string };
      }>;
      expect(rows.length).toBe(2);
      expect(rows[0]!.plannedAtMs).toBe(7000);
      expect(rows[0]!.status).toBe("failed");
      expect(rows[1]!.summary.addBinCount).toBe(3);
      expect(rows[1]!.summary.removeBinCount).toBe(1);
      expect(rows[1]!.summary.reason).toBe("recenter");
    });
  });

  it("respects and clamps limit", async () => {
    seedSubscription(PM_A, OWNER_1, 1000);
    for (let i = 0; i < 5; i++) seedRebalance(PM_A, 1000 + i, "succeeded");

    await withApi(async (base) => {
      const res = await fetch(`${base}/v1/pms/${PM_A}/rebalances?limit=2`);
      const rows = await res.json() as unknown[];
      expect(rows.length).toBe(2);

      const bad = await fetch(`${base}/v1/pms/${PM_A}/rebalances?limit=-1`);
      expect(bad.status).toBe(400);
    });
  });
});

describe("web routes: /v1/pms/:pmId/pnl", () => {
  it("returns ticks ascending and honors fromMs", async () => {
    seedSubscription(PM_A, OWNER_1, 1000);
    seedPnlTick(PM_A, 1000, 100.0);
    seedPnlTick(PM_A, 2000, 101.0);
    seedPnlTick(PM_A, 3000, 99.5);

    await withApi(async (base) => {
      const res = await fetch(`${base}/v1/pms/${PM_A}/pnl?fromMs=2000`);
      expect(res.status).toBe(200);
      const rows = await res.json() as Array<{ ts_ms: number; nav_usd: number }>;
      expect(rows.length).toBe(2);
      expect(rows[0]!.ts_ms).toBe(2000);
      expect(rows[1]!.nav_usd).toBe(99.5);
    });
  });

  it("404 for unknown pm", async () => {
    await withApi(async (base) => {
      const res = await fetch(`${base}/v1/pms/${PM_B}/pnl`);
      expect(res.status).toBe(404);
    });
  });
});

describe("web routes: pool endpoints", () => {
  it("/v1/pool/predictions returns rows newest-first with limit", async () => {
    seedPrediction(1000);
    seedPrediction(2000);
    seedPrediction(3000);

    await withApi(async (base) => {
      const res = await fetch(`${base}/v1/pool/predictions?limit=2`);
      expect(res.status).toBe(200);
      const rows = await res.json() as Array<{ ts_ms: number; executed_path: string }>;
      expect(rows.length).toBe(2);
      expect(rows[0]!.ts_ms).toBe(3000);
      expect(rows[0]!.executed_path).toBe("model");
    });
  });

  it("/v1/pool/prices thins to maxPoints", async () => {
    for (let i = 0; i < 10; i++) seedPrice(1000 + i * 100, `3.${40 + i}`);

    await withApi(async (base) => {
      const res = await fetch(`${base}/v1/pool/prices?maxPoints=5`);
      expect(res.status).toBe(200);
      const body = await res.json() as { total: number; step: number; points: Array<{ observed_ms: number }> };
      expect(body.total).toBe(10);
      expect(body.step).toBe(2);
      expect(body.points.length).toBe(5);
      expect(body.points[0]!.observed_ms).toBe(1000);
    });
  });

  it("/v1/pool/market-states returns transitions newest-first", async () => {
    seedMarketState(1000, "TREND");
    seedMarketState(2000, "EXTREME");

    await withApi(async (base) => {
      const res = await fetch(`${base}/v1/pool/market-states`);
      const rows = await res.json() as Array<{ state: string }>;
      expect(rows.length).toBe(2);
      expect(rows[0]!.state).toBe("EXTREME");
    });
  });
});

describe("web routes: /v1/risk/events", () => {
  it("filters out shadow rows", async () => {
    seedRiskEvent(1000, "live");
    seedRiskEvent(2000, "shadow");

    await withApi(async (base) => {
      const res = await fetch(`${base}/v1/risk/events`);
      const rows = await res.json() as Array<{ ts_ms: number; level: string }>;
      expect(rows.length).toBe(1);
      expect(rows[0]!.ts_ms).toBe(1000);
      expect(rows[0]!.level).toBe("L2");
    });
  });
});

describe("web routes: /v1/shadow/decisions", () => {
  it("returns rows newest-first", async () => {
    seedShadowDecision(1000);
    seedShadowDecision(2000);

    await withApi(async (base) => {
      const res = await fetch(`${base}/v1/shadow/decisions`);
      const rows = await res.json() as Array<{ ts_ms: number; strategy_output_kind: string }>;
      expect(rows.length).toBe(2);
      expect(rows[0]!.ts_ms).toBe(2000);
      expect(rows[0]!.strategy_output_kind).toBe("plan_and_reconcile");
    });
  });
});

describe("web routes: fallthrough", () => {
  it("unknown paths still 404 and POST is not matched", async () => {
    await withApi(async (base) => {
      const res = await fetch(`${base}/v1/nonsense`);
      expect(res.status).toBe(404);

      const post = await fetch(`${base}/v1/risk/events`, { method: "POST", body: "{}" });
      expect(post.status).toBe(404);
    });
  });
});
