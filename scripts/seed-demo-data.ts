/**
 * seed-demo-data.ts — populate a DEV/DEMO SQLite DB with plausible agent
 * activity so the web/ frontend can be developed and demoed before the live
 * agent has accumulated real history.
 *
 * Writes to ./data/demo.db by default (NEVER the live app.db). Override with
 * SEED_DB_FILE. Re-running wipes and re-seeds the demo tables.
 *
 * Generates ~7 days of:
 *   - subscriptions        2 PMs (owner overridable via SEED_OWNER for wallet-matched demos)
 *   - price_observations   SUI/USDC random walk w/ trend segments, 2-min cadence
 *   - predictions          5-min cadence, quantiles around the walk
 *   - market_state_history NORMAL with occasional TREND / one EXTREME episode
 *   - pnl_ticks            5-min cadence per PM, NAV drift + fee accrual
 *   - rebalances           every ~2h, mostly succeeded
 *   - shadow_decisions     15-min cadence, ML vs rule outputs
 *   - risk_events          a few L1s, one L2, plus one shadow row (must be filtered out)
 *
 * Usage: bun run scripts/seed-demo-data.ts
 */

import { openDb } from "../src/db/client.ts";

const DB_FILE = process.env.SEED_DB_FILE ?? "./data/demo.db";
const POOL_ID = process.env.SUI_USDC_POOL_ID ?? "0x64e590b0e4d4f7dfc7ae9fae8e9983cd80ad83b658d8499bf550a9d4f6667076";
const OWNER = process.env.SEED_OWNER ?? `0x${"11".repeat(32)}`;
const PM_1 = `0x${"a1".repeat(32)}`;
const PM_2 = `0x${"b2".repeat(32)}`;
const COIN_USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const COIN_SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

const DAYS = 7;
const NOW = Date.now();
const START = NOW - DAYS * 24 * 3600 * 1000;

const db = openDb(DB_FILE);

// Wipe previous seed so re-runs are idempotent.
for (const t of [
  "subscriptions", "price_observations", "predictions", "market_state_history",
  "pnl_ticks", "rebalances", "shadow_decisions", "risk_events",
]) {
  db.exec(`DELETE FROM ${t}`);
}

// --- subscriptions ----------------------------------------------------------
const subStmt = db.prepare(
  "INSERT INTO subscriptions (pm_id, owner, pool_id, coin_type_a, coin_type_b, status, added_at_ms) VALUES (?, ?, ?, ?, ?, 'active', ?)",
);
subStmt.run(PM_1, OWNER, POOL_ID, COIN_USDC, COIN_SUI, START);
subStmt.run(PM_2, OWNER, POOL_ID, COIN_USDC, COIN_SUI, START + 36 * 3600 * 1000);

// --- price walk (shared timeline for everything else) ------------------------
// SUI/USDC around 3.40 with gentle mean-reversion + two trend segments.
interface Pt { ts: number; price: number }
const walk: Pt[] = [];
let price = 3.4;
const PRICE_STEP_MS = 2 * 60 * 1000;
for (let ts = START; ts <= NOW; ts += PRICE_STEP_MS) {
  const dayFrac = (ts - START) / (24 * 3600 * 1000);
  // trend segments: day 2.0–2.6 up-trend, day 4.5–5.0 down-trend
  const drift =
    dayFrac > 2.0 && dayFrac < 2.6 ? 0.0009 :
    dayFrac > 4.5 && dayFrac < 5.0 ? -0.0013 :
    (3.4 - price) * 0.002; // mean-revert
  price = Math.max(2.5, price + drift + (Math.random() - 0.5) * 0.006);
  walk.push({ ts, price });
}

const priceStmt = db.prepare(
  "INSERT INTO price_observations (pool_id, source, price, observed_ms) VALUES (?, ?, ?, ?)",
);
const insertPrices = db.transaction(() => {
  for (const p of walk) {
    priceStmt.run(POOL_ID, Math.random() < 0.5 ? "binance" : "onchain", p.price.toFixed(6), p.ts);
  }
});
insertPrices();

// bin math for a binStep-50 pool quoted USDC-per-SUI (poolCoinAIsQuote=true →
// bin id ↑ = price ↓; for demo purposes a simple monotone map is enough).
const BIN_BASE = 1000;
function binForPrice(p: number): number {
  return Math.round(BIN_BASE - Math.log(p / 3.4) / Math.log(1.005));
}

// --- predictions (5-min) -----------------------------------------------------
const predStmt = db.prepare(
  "INSERT INTO predictions (pool_id, ts_ms, model_version, active_bin, width_sigma, p_above, p_below, feature_completeness, psi, fallback, executed_path, infer_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
);
const insertPreds = db.transaction(() => {
  for (let i = 0; i < walk.length; i += 3) { // ~6-min cadence
    const p = walk[i]!;
    const activeBin = binForPrice(p.price);
    const sigma = 1.0 + Math.random() * 1.5;
    const fallback = Math.random() < 0.04;
    predStmt.run(
      POOL_ID, p.ts, "lgbm-vol-20260711", activeBin,
      sigma,
      0.15 + (Math.random() - 0.5) * 0.05,
      0.15 + (Math.random() - 0.5) * 0.05,
      fallback ? 0.72 : 0.97 + Math.random() * 0.03,
      0.02 + Math.random() * 0.08,
      fallback ? "low_feature_completeness" : null,
      fallback ? "tier0_fallback" : "model",
      8 + Math.floor(Math.random() * 20),
    );
  }
});
insertPreds();

// --- market_state_history -----------------------------------------------------
// NORMAL baseline; TREND during the two walk trend segments; one 40-min EXTREME.
const stateStmt = db.prepare(
  "INSERT INTO market_state_history (pool_id, entered_at_ms, exited_at_ms, state, trigger, prev_state) VALUES (?, ?, ?, ?, ?, ?)",
);
const d = (n: number) => START + n * 24 * 3600 * 1000;
const episodes: Array<[number, number | null, string, string, string | null]> = [
  [START, d(2.0), "NORMAL", "startup", null],
  [d(2.0), d(2.6), "TREND", "ema_cross_up", "NORMAL"],
  [d(2.6), d(3.7), "NORMAL", "trend_decay", "TREND"],
  [d(3.7), d(3.7) + 40 * 60 * 1000, "EXTREME", "sigma_jump", "NORMAL"],
  [d(3.7) + 40 * 60 * 1000, d(4.5), "NORMAL", "vol_normalized", "EXTREME"],
  [d(4.5), d(5.0), "TREND", "ema_cross_down", "NORMAL"],
  [d(5.0), null, "NORMAL", "trend_decay", "TREND"],
];
for (const [enter, exit, state, trigger, prev] of episodes) {
  stateStmt.run(POOL_ID, enter, exit, state, trigger, prev);
}
function stateAt(ts: number): string {
  for (const [enter, exit, state] of episodes) {
    if (ts >= enter && (exit === null || ts < exit)) return state;
  }
  return "NORMAL";
}

// --- rebalances (~2h cadence) + pnl_ticks (5-min per PM) ----------------------
const rebStmt = db.prepare(
  "INSERT INTO rebalances (pm_id, planned_at_ms, submitted_at_ms, digest, plan_json, status, error) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
);
const pnlStmt = db.prepare(
  "INSERT INTO pnl_ticks (pool_id, pm_id, ts_ms, fee_income_usd, cost_credits, inventory_delta_usd, il_usd, nav_usd, market_state, rebalance_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
);

function fakeDigest(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz123456789";
  let s = "";
  for (let i = 0; i < 44; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

const seedPmActivity = db.transaction((pmId: string, startTs: number, nav0: number) => {
  let nav = nav0;
  let cumFees = 0;
  let nextRebalance = startTs + (1.5 + Math.random()) * 3600 * 1000;
  for (let i = 0; i < walk.length; i += 2) { // ~4-min ticks
    const p = walk[i]!;
    if (p.ts < startTs) continue;
    const state = stateAt(p.ts);
    let rebalanceId: number | null = null;

    if (p.ts >= nextRebalance) {
      const activeBin = binForPrice(p.price);
      const failed = Math.random() < 0.06;
      const bins = Array.from({ length: 5 }, (_, k) => activeBin - 2 + k).filter((b) => b !== activeBin);
      const plan = {
        pmId,
        removeShares: Object.fromEntries(bins.slice(0, 3).map((b) => [String(b + 1), String(10n ** 9n)])),
        addAmountA: String(Math.round(nav * 0.5 * 1e6)),
        addAmountB: String(Math.round((nav * 0.5 / p.price) * 1e9)),
        addBins: bins,
        addAmountsA: bins.map((b) => (b < activeBin ? "0" : String(Math.round(nav * 0.25 * 1e6)))),
        addAmountsB: bins.map((b) => (b > activeBin ? "0" : String(Math.round((nav * 0.25 / p.price) * 1e9)))),
        collectFees: true,
        reason: state === "EXTREME" ? "EXTREME: full withdrawal to balance" :
                state === "TREND" ? "trend recenter with directional bias" :
                "drift recenter around predicted center",
        plannedActiveBinId: activeBin,
        priority: state === "EXTREME" ? "emergency" : "normal",
      };
      const row = rebStmt.get(
        pmId, p.ts, p.ts + 1200 + Math.floor(Math.random() * 2500),
        failed ? null : fakeDigest(),
        JSON.stringify(plan),
        failed ? "failed" : "succeeded",
        failed ? "active bin drifted 4 bins > SLIPPAGE_MAX_BIN_DRIFT (3); replanned next tick" : null,
      ) as { id: number };
      if (!failed) rebalanceId = row.id;
      nextRebalance = p.ts + (1.5 + Math.random() * 1.5) * 3600 * 1000;
    }

    const feeTick = state === "TREND" ? 0.05 + Math.random() * 0.12 : 0.02 + Math.random() * 0.06;
    cumFees += feeTick;
    const marketMove = (Math.random() - 0.495) * 0.9;
    nav = Math.max(200, nav + feeTick + marketMove);
    pnlStmt.run(
      POOL_ID, pmId, p.ts,
      Number(feeTick.toFixed(4)), rebalanceId ? 12 : 0,
      Number(marketMove.toFixed(4)),
      Number((-Math.random() * 0.05).toFixed(4)),
      Number(nav.toFixed(2)), state, rebalanceId,
    );
  }
  return cumFees;
});

const fees1 = seedPmActivity(PM_1, START, 1000);
const fees2 = seedPmActivity(PM_2, START + 36 * 3600 * 1000, 2500);

// --- shadow_decisions (15-min) -------------------------------------------------
const shadowStmt = db.prepare(
  "INSERT INTO shadow_decisions (pool_id, pm_id, ts_ms, market_state, strategy_output_kind, strategy_output_json, rule_output_kind, rule_output_json, lending_pct, half_width, trend_bias, model_version, active_bin, spot_price, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
);
const insertShadow = db.transaction(() => {
  for (let i = 0; i < walk.length; i += 7) { // ~15-min
    const p = walk[i]!;
    const state = stateAt(p.ts);
    const mlQuiet = Math.random() < 0.55;
    const ruleQuiet = Math.random() < 0.7;
    const mlKind = mlQuiet ? "quiet" : "plan_and_reconcile";
    const ruleKind = ruleQuiet ? "quiet" : "plan_and_reconcile";
    shadowStmt.run(
      POOL_ID, PM_1, p.ts, state,
      mlKind, JSON.stringify({ kind: mlKind, halfWidth: 4 + Math.floor(Math.random() * 4) }),
      ruleKind, JSON.stringify({ kind: ruleKind, halfWidth: 6 }),
      0.1 + Math.random() * 0.3,
      4 + Math.floor(Math.random() * 4),
      Number(((Math.random() - 0.5) * 0.8).toFixed(3)),
      "lgbm-q-20260701",
      binForPrice(p.price), p.price.toFixed(6), p.ts,
    );
  }
});
insertShadow();

// --- risk_events ---------------------------------------------------------------
const riskStmt = db.prepare(
  "INSERT INTO risk_events (pool_id, pm_id, ts_ms, level, kind, metric, threshold, observed, action, source, resolved_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
);
riskStmt.run(POOL_ID, PM_1, d(1.2), "L1", "bin_drift", "active_bin_drift_bins", 3, 4, "tighten_eval_interval", "live", d(1.2) + 20 * 60 * 1000);
riskStmt.run(POOL_ID, null, d(2.1), "L1", "vol_spike", "sigma_5m_ratio", 2.0, 2.4, "widen_target_range", "live", d(2.1) + 35 * 60 * 1000);
riskStmt.run(POOL_ID, PM_1, d(3.7), "L2", "sigma_jump", "sigma_jump_zscore", 3.0, 4.6, "pause_and_widen", "live", d(3.7) + 50 * 60 * 1000);
riskStmt.run(POOL_ID, PM_2, d(5.5), "L1", "fee_apr_drop", "fee_apr_24h_pct", 5.0, 3.1, "log_only", "live", null);
riskStmt.run(POOL_ID, PM_1, d(4.0), "L1", "shadow_metric", "shadow_only", 1, 2, "none", "shadow", null);

// --- summary -------------------------------------------------------------------
const count = (t: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;

console.log(`seeded ${DB_FILE}:`);
for (const t of [
  "subscriptions", "price_observations", "predictions", "market_state_history",
  "pnl_ticks", "rebalances", "shadow_decisions", "risk_events",
]) {
  console.log(`  ${t}: ${count(t)}`);
}
console.log(`  cumulative fees: PM1 $${fees1.toFixed(2)}, PM2 $${fees2.toFixed(2)}`);
console.log(`  owner: ${OWNER}`);
console.log(`\nrun the API against it: DB_FILE=${DB_FILE} TREASURY_HTTP_ENABLED=true bun start`);
