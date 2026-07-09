/**
 * Read-only web API routes.
 *
 * Serves the web/ frontend's data needs (agent activity, PnL, predictions,
 * risk, shadow decisions) off the agent's SQLite DB. Mounted into the
 * treasury HTTP server (src/treasury/httpApi.ts) just before its 404
 * fallback — same host/port/gating (TREASURY_HTTP_ENABLED), no new server.
 *
 * Every endpoint is GET, unauthenticated, and read-only. Unknown PM ids
 * return 404 — no data is synthesized.
 */

import type { AppConfig } from "../config.ts";
import { getDb } from "../db/client.ts";
import { CDPM_PACKAGE } from "../sui/cdpm/package.ts";

const SUI_ADDR_RE = /^0x[0-9a-fA-F]{64}$/;

// Local copies of the treasury httpApi JSON helpers — duplicated (10 lines)
// instead of imported so routes.ts ⇄ httpApi.ts never form an import cycle.
function json(body: unknown, status = 200): Response {
  return new Response(
    JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

function err(status: number, message: string): Response {
  return json({ error: message }, status);
}

/**
 * Parse a positive-integer query param, clamped to `max`. Returns the default
 * when absent; a Response(400) when present but malformed.
 */
function intParam(url: URL, name: string, dflt: number, max: number): number | Response {
  const raw = url.searchParams.get(name);
  if (raw === null) return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    return err(400, `${name} must be a positive integer`);
  }
  return Math.min(n, max);
}

/** Like intParam but allows 0 (timestamps). */
function tsParam(url: URL, name: string, dflt: number): number | Response {
  const raw = url.searchParams.get(name);
  if (raw === null) return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    return err(400, `${name} must be a non-negative integer`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleAgentSummary(cfg: AppConfig): Response {
  const db = getDb();
  const p = cfg.poolProfile;

  const activePms = db
    .prepare<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM subscriptions WHERE status = 'active'",
    )
    .get()!.n;
  const lastRebalance = db
    .prepare<{ ts: number | null }, []>(
      "SELECT MAX(submitted_at_ms) AS ts FROM rebalances WHERE status = 'succeeded'",
    )
    .get()!.ts;
  const latestModel = db
    .prepare<{ model_version: string }, [string]>(
      "SELECT model_version FROM predictions WHERE pool_id = ? ORDER BY ts_ms DESC LIMIT 1",
    )
    .get(p.poolId);
  const rebalanceCount = db
    .prepare<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM rebalances WHERE status = 'succeeded'",
    )
    .get()!.n;

  return json({
    agentAddress: cfg.keys.agent.expectedAddress,
    cdpmPackage: CDPM_PACKAGE,
    strategy: cfg.strategy,
    pool: {
      name: p.name,
      poolId: p.poolId,
      coinTypeA: p.coinTypeA,
      coinTypeB: p.coinTypeB,
      decimalsA: p.decimalsA,
      decimalsB: p.decimalsB,
      binStep: p.binStep,
      pricePairLabel: p.pricePairLabel,
      poolCoinAIsQuote: p.poolCoinAIsQuote ?? false,
    },
    activePms,
    succeededRebalances: rebalanceCount,
    lastRebalanceMs: lastRebalance,
    modelVersion: latestModel?.model_version ?? null,
  });
}

function handleListPms(url: URL): Response {
  const owner = url.searchParams.get("owner");
  if (owner !== null && !SUI_ADDR_RE.test(owner)) {
    return err(400, "invalid owner address format");
  }
  const db = getDb();
  const rows = owner
    ? db
        .prepare(
          "SELECT pm_id, owner, pool_id, coin_type_a, coin_type_b, status, added_at_ms, removed_at_ms FROM subscriptions WHERE owner = ? ORDER BY added_at_ms DESC",
        )
        .all(owner)
    : db
        .prepare(
          "SELECT pm_id, owner, pool_id, coin_type_a, coin_type_b, status, added_at_ms, removed_at_ms FROM subscriptions ORDER BY added_at_ms DESC",
        )
        .all();
  return json(rows);
}

/** 404 when the PM is known to neither subscriptions nor the queried table. */
function pmKnown(pmId: string, table: "rebalances" | "pnl_ticks"): boolean {
  const db = getDb();
  const inSubs = db
    .prepare<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM subscriptions WHERE pm_id = ?")
    .get(pmId)!.n;
  if (inSubs > 0) return true;
  const inTable = db
    .prepare<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM ${table} WHERE pm_id = ?`)
    .get(pmId)!.n;
  return inTable > 0;
}

interface RebalanceRow {
  id: number;
  pm_id: string;
  planned_at_ms: number;
  submitted_at_ms: number | null;
  digest: string | null;
  plan_json: string;
  status: string;
  error: string | null;
}

function handleRebalances(pmId: string, url: URL): Response {
  if (!SUI_ADDR_RE.test(pmId)) return err(400, "invalid pmId format");
  const limit = intParam(url, "limit", 50, 200);
  if (limit instanceof Response) return limit;
  if (!pmKnown(pmId, "rebalances")) return err(404, "unknown pmId");

  const rows = getDb()
    .prepare<RebalanceRow, [string, number]>(
      "SELECT id, pm_id, planned_at_ms, submitted_at_ms, digest, plan_json, status, error FROM rebalances WHERE pm_id = ? ORDER BY planned_at_ms DESC LIMIT ?",
    )
    .all(pmId, limit);

  // plan_json is written by this agent's own rebalancer; a parse failure is
  // data corruption and must surface as a 500, not be papered over.
  const out = rows.map((r) => {
    const plan = JSON.parse(r.plan_json) as {
      reason?: string;
      addBins?: number[];
      addAmountA?: string;
      addAmountB?: string;
      removeShares?: Record<string, string>;
      plannedActiveBinId?: number;
      priority?: string;
      collectFees?: boolean;
    };
    return {
      id: r.id,
      pmId: r.pm_id,
      plannedAtMs: r.planned_at_ms,
      submittedAtMs: r.submitted_at_ms,
      digest: r.digest,
      status: r.status,
      error: r.error,
      summary: {
        reason: plan.reason ?? "",
        addBinCount: plan.addBins?.length ?? 0,
        addAmountA: plan.addAmountA ?? "0",
        addAmountB: plan.addAmountB ?? "0",
        removeBinCount: Object.keys(plan.removeShares ?? {}).length,
        plannedActiveBinId: plan.plannedActiveBinId ?? null,
        priority: plan.priority ?? "normal",
        collectFees: plan.collectFees ?? false,
      },
      plan,
    };
  });
  return json(out);
}

function handlePnl(pmId: string, url: URL): Response {
  if (!SUI_ADDR_RE.test(pmId)) return err(400, "invalid pmId format");
  const fromMs = tsParam(url, "fromMs", 0);
  if (fromMs instanceof Response) return fromMs;
  if (!pmKnown(pmId, "pnl_ticks")) return err(404, "unknown pmId");

  const rows = getDb()
    .prepare(
      "SELECT ts_ms, fee_income_usd, cost_credits, inventory_delta_usd, il_usd, nav_usd, market_state, rebalance_id FROM pnl_ticks WHERE pm_id = ? AND ts_ms >= ? ORDER BY ts_ms ASC LIMIT 10000",
    )
    .all(pmId, fromMs);
  return json(rows);
}

function handlePredictions(cfg: AppConfig, url: URL): Response {
  const limit = intParam(url, "limit", 200, 1000);
  if (limit instanceof Response) return limit;
  const rows = getDb()
    .prepare(
      "SELECT ts_ms, model_version, active_bin, center_q10, center_offset, center_q90, width_sigma, p_above, p_below, feature_completeness, psi, fallback, executed_path, infer_ms FROM predictions WHERE pool_id = ? ORDER BY ts_ms DESC LIMIT ?",
    )
    .all(cfg.poolProfile.poolId, limit);
  return json(rows);
}

interface PriceRow {
  price: string;
  observed_ms: number;
  source: string;
}

function handlePrices(cfg: AppConfig, url: URL): Response {
  const fromMs = tsParam(url, "fromMs", 0);
  if (fromMs instanceof Response) return fromMs;
  const maxPoints = intParam(url, "maxPoints", 500, 2000);
  if (maxPoints instanceof Response) return maxPoints;

  const db = getDb();
  const poolId = cfg.poolProfile.poolId;
  const total = db
    .prepare<{ n: number }, [string, number]>(
      "SELECT COUNT(*) AS n FROM price_observations WHERE pool_id = ? AND observed_ms >= ?",
    )
    .get(poolId, fromMs)!.n;

  // Thin server-side: keep every Nth row so the payload stays ≤ maxPoints.
  const step = Math.max(1, Math.ceil(total / maxPoints));
  const rows = db
    .prepare<PriceRow, [string, number, number]>(
      `SELECT price, observed_ms, source FROM (
         SELECT price, observed_ms, source,
                ROW_NUMBER() OVER (ORDER BY observed_ms ASC) AS rn
         FROM price_observations WHERE pool_id = ? AND observed_ms >= ?
       ) WHERE (rn - 1) % ? = 0 ORDER BY observed_ms ASC`,
    )
    .all(poolId, fromMs, step);
  return json({ total, step, points: rows });
}

function handleMarketStates(cfg: AppConfig, url: URL): Response {
  const limit = intParam(url, "limit", 50, 500);
  if (limit instanceof Response) return limit;
  const rows = getDb()
    .prepare(
      "SELECT entered_at_ms, exited_at_ms, state, trigger, prev_state FROM market_state_history WHERE pool_id = ? ORDER BY entered_at_ms DESC LIMIT ?",
    )
    .all(cfg.poolProfile.poolId, limit);
  return json(rows);
}

function handleRiskEvents(url: URL): Response {
  const limit = intParam(url, "limit", 100, 500);
  if (limit instanceof Response) return limit;
  const rows = getDb()
    .prepare(
      "SELECT pool_id, pm_id, ts_ms, level, kind, metric, threshold, observed, action, resolved_at_ms FROM risk_events WHERE source = 'live' ORDER BY ts_ms DESC LIMIT ?",
    )
    .all(limit);
  return json(rows);
}

function handleShadowDecisions(url: URL): Response {
  const limit = intParam(url, "limit", 100, 500);
  if (limit instanceof Response) return limit;
  const rows = getDb()
    .prepare(
      "SELECT pool_id, pm_id, ts_ms, market_state, strategy_output_kind, rule_output_kind, lending_pct, half_width, trend_bias, model_version, prediction_id, active_bin, spot_price FROM shadow_decisions ORDER BY ts_ms DESC LIMIT ?",
    )
    .all(limit);
  return json(rows);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const PM_ROUTE_RE = /^\/v1\/pms\/(0x[0-9a-fA-F]{1,64})\/(rebalances|pnl)$/;

/**
 * Match a read-only web route. Returns null when the path is not ours so the
 * caller (treasury httpApi) can continue to its own 404 fallback.
 */
export function matchWebRoute(
  cfg: AppConfig,
  method: string,
  pathname: string,
  url: URL,
): Response | null {
  if (method !== "GET") return null;

  if (pathname === "/v1/agent/summary") return handleAgentSummary(cfg);
  if (pathname === "/v1/pms") return handleListPms(url);
  if (pathname === "/v1/pool/predictions") return handlePredictions(cfg, url);
  if (pathname === "/v1/pool/prices") return handlePrices(cfg, url);
  if (pathname === "/v1/pool/market-states") return handleMarketStates(cfg, url);
  if (pathname === "/v1/risk/events") return handleRiskEvents(url);
  if (pathname === "/v1/shadow/decisions") return handleShadowDecisions(url);

  const pm = PM_ROUTE_RE.exec(pathname);
  if (pm) {
    const [, pmId, sub] = pm;
    if (sub === "rebalances") return handleRebalances(pmId!, url);
    return handlePnl(pmId!, url);
  }

  return null;
}
