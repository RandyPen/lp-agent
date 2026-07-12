/**
 * Typed fetch client for the agent's read-only API (src/web/routes.ts) and
 * the treasury endpoints (src/treasury/httpApi.ts). All paths go through the
 * Vite /v1 proxy to 127.0.0.1:8378.
 */

export interface AgentSummary {
  agentAddress: string;
  cdpmPackage: string;
  strategy: string;
  pool: {
    name: string;
    poolId: string;
    coinTypeA: string;
    coinTypeB: string;
    decimalsA: number;
    decimalsB: number;
    binStep: number;
    pricePairLabel: string;
    poolCoinAIsQuote: boolean;
  };
  activePms: number;
  succeededRebalances: number;
  lastRebalanceMs: number | null;
  modelVersion: string | null;
  /** True when the API serves a seeded demo dataset — the UI shows a banner. */
  demo?: boolean;
}

export interface PmSubscription {
  pm_id: string;
  owner: string;
  pool_id: string;
  coin_type_a: string;
  coin_type_b: string;
  status: "active" | "revoked" | "closed";
  added_at_ms: number;
  removed_at_ms: number | null;
}

export interface RebalanceSummary {
  reason: string;
  addBinCount: number;
  addAmountA: string;
  addAmountB: string;
  removeBinCount: number;
  plannedActiveBinId: number | null;
  priority: string;
  collectFees: boolean;
}

export interface RebalanceEntry {
  id: number;
  pmId: string;
  plannedAtMs: number;
  submittedAtMs: number | null;
  digest: string | null;
  status: "planned" | "submitted" | "succeeded" | "failed";
  error: string | null;
  summary: RebalanceSummary;
  plan: Record<string, unknown>;
}

export interface PnlTick {
  ts_ms: number;
  fee_income_usd: number;
  cost_credits: number;
  inventory_delta_usd: number;
  il_usd: number | null;
  nav_usd: number;
  market_state: "NORMAL" | "TREND" | "EXTREME" | null;
  rebalance_id: number | null;
}

export interface Prediction {
  ts_ms: number;
  model_version: string;
  active_bin: number;
  // center_* columns were removed with the center prediction head (2026-07):
  // the band is now active_bin ± 1.28 × width_sigma.
  width_sigma: number;
  p_above: number;
  p_below: number;
  feature_completeness: number;
  psi: number;
  fallback: string | null;
  executed_path: "model" | "tier0_fallback" | "tier0_probation";
  infer_ms: number;
}

export interface PricePoint {
  price: string;
  observed_ms: number;
  source: string;
}

export interface PriceSeries {
  total: number;
  step: number;
  points: PricePoint[];
}

export interface MarketStateEpisode {
  entered_at_ms: number;
  exited_at_ms: number | null;
  state: "NORMAL" | "TREND" | "EXTREME";
  trigger: string;
  prev_state: string | null;
}

export interface RiskEvent {
  pool_id: string | null;
  pm_id: string | null;
  ts_ms: number;
  level: "L1" | "L2" | "L3";
  kind: string;
  metric: string;
  threshold: number;
  observed: number;
  action: string;
  resolved_at_ms: number | null;
}

export interface ShadowDecision {
  pool_id: string;
  pm_id: string;
  ts_ms: number;
  market_state: "NORMAL" | "TREND" | "EXTREME";
  strategy_output_kind: string;
  rule_output_kind: string | null;
  lending_pct: number | null;
  half_width: number | null;
  trend_bias: number | null;
  model_version: string | null;
  prediction_id: number | null;
  active_bin: number | null;
  spot_price: string | null;
}

export interface TreasuryUser {
  suiAddress: string;
  depositAddress: string;
  credits: number;
  createdAtMs?: number;
}

export interface Deposit {
  id: string;
  suiAddress: string;
  depositAddress: string;
  coinType: string;
  amountDelta: string;
  creditsGranted: number;
  observedAtMs: number;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(res.status, body?.error ?? `${path}: HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export const api = {
  agentSummary: () => get<AgentSummary>("/v1/agent/summary"),
  pms: (owner?: string) =>
    get<PmSubscription[]>(owner ? `/v1/pms?owner=${owner}` : "/v1/pms"),
  rebalances: (pmId: string, limit = 50) =>
    get<RebalanceEntry[]>(`/v1/pms/${pmId}/rebalances?limit=${limit}`),
  pnl: (pmId: string, fromMs = 0) =>
    get<PnlTick[]>(`/v1/pms/${pmId}/pnl?fromMs=${fromMs}`),
  predictions: (limit = 200) =>
    get<Prediction[]>(`/v1/pool/predictions?limit=${limit}`),
  prices: (fromMs = 0, maxPoints = 500) =>
    get<PriceSeries>(`/v1/pool/prices?fromMs=${fromMs}&maxPoints=${maxPoints}`),
  marketStates: (limit = 50) =>
    get<MarketStateEpisode[]>(`/v1/pool/market-states?limit=${limit}`),
  riskEvents: (limit = 100) => get<RiskEvent[]>(`/v1/risk/events?limit=${limit}`),
  shadowDecisions: (limit = 100) =>
    get<ShadowDecision[]>(`/v1/shadow/decisions?limit=${limit}`),

  // Treasury (existing endpoints)
  user: (suiAddress: string) => get<TreasuryUser>(`/v1/users/${suiAddress}`),
  deposits: (suiAddress: string, limit = 50) =>
    get<Deposit[]>(`/v1/users/${suiAddress}/deposits?limit=${limit}`),
  register: async (body: { suiAddress: string; messageB64: string; signature: string }) => {
    const res = await fetch("/v1/users/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new ApiError(res.status, err?.error ?? `register: HTTP ${res.status}`);
    }
    return (await res.json()) as TreasuryUser;
  },
};
