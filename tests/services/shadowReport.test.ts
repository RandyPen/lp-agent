/**
 * tests/services/shadowReport.test.ts — agreement + hypothetical in-range
 * scoring over seeded shadow_decisions / price_observations fixtures.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { computeShadowReport } from "../../src/services/shadowReport.ts";
import { humanPriceForBin, orientationOf } from "../../src/domain/binMath.ts";
import type { PoolProfile } from "../../src/pools/types.ts";

const POOL_ID = "0xpool";
const PM_ID = "0xpm";
const T0 = 1_700_000_000_000;
const MIN = 60_000;

/** Non-inverted 9/6 profile — human price rises with bin id. */
const PROFILE: PoolProfile = {
  name: "test",
  poolId: POOL_ID,
  coinTypeA: "0x2::sui::SUI",
  coinTypeB: "0xu::usdc::USDC",
  decimalsA: 9,
  decimalsB: 6,
  binStep: 10,
  pricePairLabel: "SUI/USDC",
  defaultStrategyParams: { binWidth: 7, expectedFeeBps: 40 },
  lendingPolicy: {},
  network: "mainnet",
};

function openTestDb(): Database {
  const db = new Database(":memory:");
  const here = dirname(fileURLToPath(import.meta.url));
  db.exec(readFileSync(resolve(here, "../../src/db/schema.sql"), "utf8"));
  return db;
}

function seedDecision(
  db: Database,
  tsMs: number,
  mlKind: string,
  mlBins: number[] | null,
  ruleKind: string | null,
  ruleBins: number[] | null,
  state = "NORMAL",
): void {
  const mlJson = mlBins
    ? JSON.stringify({ kind: mlKind, plan: { addBins: mlBins } })
    : JSON.stringify({ kind: mlKind, reason: "quiet" });
  const ruleJson =
    ruleKind === null
      ? null
      : ruleBins
        ? JSON.stringify({ kind: ruleKind, plan: { addBins: ruleBins } })
        : JSON.stringify({ kind: ruleKind, reason: "quiet" });
  db.prepare(
    `INSERT INTO shadow_decisions
       (pool_id, pm_id, ts_ms, market_state, strategy_output_kind, strategy_output_json,
        rule_output_kind, rule_output_json, model_version, active_bin, spot_price, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'shadow:mlAgent', 100, '1.0', ?)`,
  ).run(POOL_ID, PM_ID, tsMs, state, mlKind, mlJson, ruleKind, ruleJson, tsMs);
}

function seedPrice(db: Database, tsMs: number, binId: number): void {
  const price = humanPriceForBin(orientationOf(PROFILE), binId);
  db.prepare(
    `INSERT INTO price_observations (pool_id, source, price, observed_ms) VALUES (?, 'test', ?, ?)`,
  ).run(POOL_ID, String(price), tsMs);
}

let db: Database;
beforeEach(() => {
  db = openTestDb();
});

describe("computeShadowReport", () => {
  it("empty window → zero rows, null rates", () => {
    const r = computeShadowReport(db, { poolId: POOL_ID, profile: PROFILE, sinceMs: 0, untilMs: T0 });
    expect(r.rows).toBe(0);
    expect(r.kindAgreementRate).toBe(null);
    expect(r.mlInRangeRate).toBe(null);
  });

  it("kind agreement and Jaccard overlap", () => {
    seedDecision(db, T0, "plan_and_reconcile", [98, 99, 101], "plan_and_reconcile", [99, 101, 102]);
    seedDecision(db, T0 + MIN, "quiet", null, "plan_and_reconcile", [99]);
    const r = computeShadowReport(db, {
      poolId: POOL_ID, profile: PROFILE, sinceMs: 0, untilMs: T0 + 2 * MIN,
    });
    expect(r.rows).toBe(2);
    expect(r.rowsWithBaseline).toBe(2);
    expect(r.kindAgreementRate).toBeCloseTo(0.5, 10);
    // Jaccard({98,99,101},{99,101,102}) = 2/4 = 0.5 over 1 both-planned row.
    expect(r.bothPlannedRows).toBe(1);
    expect(r.meanBinJaccard).toBeCloseTo(0.5, 10);
  });

  it("hypothetical in-range scores each arm against subsequent prices", () => {
    // ml range [99..101], rule range [102..104]; prices then sit at bins
    // 100, 100, 103, 90 → ml in-range 2/4, rule 1/4.
    seedDecision(db, T0, "plan_and_reconcile", [99, 100, 101], "plan_and_reconcile", [102, 103, 104]);
    seedPrice(db, T0 + 1 * MIN, 100);
    seedPrice(db, T0 + 2 * MIN, 100);
    seedPrice(db, T0 + 3 * MIN, 103);
    seedPrice(db, T0 + 4 * MIN, 90);

    const r = computeShadowReport(db, {
      poolId: POOL_ID, profile: PROFILE, sinceMs: 0, untilMs: T0 + 10 * MIN,
    });
    expect(r.scoredDecisions).toBe(1);
    expect(r.mlInRangeRate).toBeCloseTo(0.5, 10);
    expect(r.ruleInRangeRate).toBeCloseTo(0.25, 10);
  });

  it("scoring window ends at the next decision for the same PM", () => {
    // First decision: range [99..101]; prices in its window are in range.
    seedDecision(db, T0, "plan_and_reconcile", [99, 100, 101], null, null);
    seedPrice(db, T0 + 1 * MIN, 100);
    // Second decision at T0+2min: range [200..202]; the later price (bin 100)
    // must NOT count against the FIRST decision's window.
    seedDecision(db, T0 + 2 * MIN, "plan_and_reconcile", [200, 201, 202], null, null);
    seedPrice(db, T0 + 3 * MIN, 100);

    const r = computeShadowReport(db, {
      poolId: POOL_ID, profile: PROFILE, sinceMs: 0, untilMs: T0 + 10 * MIN,
    });
    expect(r.scoredDecisions).toBe(2);
    // First window: 1/1 in range; second: 0/1 → mean 0.5.
    expect(r.mlInRangeRate).toBeCloseTo(0.5, 10);
  });

  it("state and kind distributions", () => {
    seedDecision(db, T0, "quiet", null, null, null, "NORMAL");
    seedDecision(db, T0 + MIN, "plan_and_reconcile", [99], null, null, "TREND");
    const r = computeShadowReport(db, {
      poolId: POOL_ID, profile: PROFILE, sinceMs: 0, untilMs: T0 + 5 * MIN,
    });
    expect(r.byState).toEqual({ NORMAL: 1, TREND: 1 });
    expect(r.byMlKind).toEqual({ quiet: 1, plan_and_reconcile: 1 });
  });
});

describe("ensureColumns (additive schema guard)", () => {
  it("adds the new columns to a pre-existing DB missing them", async () => {
    // Simulate a DB created before the columns shipped.
    const legacy = new Database(":memory:");
    legacy.exec(`
      CREATE TABLE shadow_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pool_id TEXT NOT NULL, pm_id TEXT NOT NULL, ts_ms INTEGER NOT NULL,
        market_state TEXT NOT NULL, strategy_output_kind TEXT NOT NULL,
        strategy_output_json TEXT NOT NULL, rule_output_kind TEXT,
        rule_output_json TEXT, lending_pct REAL, half_width INTEGER,
        trend_bias REAL, model_version TEXT, prediction_id INTEGER,
        created_at_ms INTEGER NOT NULL
      );
      CREATE TABLE risk_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pool_id TEXT, pm_id TEXT, ts_ms INTEGER NOT NULL, level TEXT NOT NULL,
        kind TEXT NOT NULL, metric TEXT NOT NULL, threshold REAL NOT NULL,
        observed REAL NOT NULL, action TEXT NOT NULL, resolved_at_ms INTEGER
      );
      INSERT INTO risk_events (pool_id, pm_id, ts_ms, level, kind, metric, threshold, observed, action)
      VALUES ('0xp', NULL, 1, 'L2', 'k', 'm', 0, 1, 'a');
    `);
    // Run the full schema (CREATE IF NOT EXISTS no-ops) + the additive guard.
    const here = dirname(fileURLToPath(import.meta.url));
    legacy.exec(readFileSync(resolve(here, "../../src/db/schema.sql"), "utf8"));
    const { ensureColumnsForTests } = await import("../../src/db/client.ts");
    ensureColumnsForTests(legacy);

    const shadowCols = legacy.prepare<{ name: string }, []>(`PRAGMA table_info(shadow_decisions)`).all();
    expect(shadowCols.some((c) => c.name === "active_bin")).toBe(true);
    expect(shadowCols.some((c) => c.name === "spot_price")).toBe(true);

    const riskCols = legacy.prepare<{ name: string }, []>(`PRAGMA table_info(risk_events)`).all();
    expect(riskCols.some((c) => c.name === "source")).toBe(true);
    // Pre-existing row got the 'live' default.
    const row = legacy.prepare<{ source: string }, []>(`SELECT source FROM risk_events LIMIT 1`).get();
    expect(row?.source).toBe("live");
  });
});
