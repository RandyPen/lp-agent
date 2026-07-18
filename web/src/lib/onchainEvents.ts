/**
 * On-chain agent activity — queried DIRECTLY from Sui GraphQL (no backend).
 *
 * Every row is a real mainnet transaction. We surface the four Agent* event
 * structs the CDPM package emits when an AUTHORIZED AGENT acts — across ALL
 * PositionManagers, including third-party agents that are not ours.
 *
 * Why filter by event `type`, not by `module`:
 *   The cdpm module also emits Protocol* events (user/owner-initiated deposits)
 *   and, within the same transactions, Cetus `pool::*` events. A broad
 *   `filter: { module: "<pkg>::cdpm" }` query returns all of those interleaved,
 *   so the sparser Agent* rows get crowded off the most-recent page and never
 *   render. Filtering by the exact Agent* `type` strings pulls agent activity
 *   directly. (Schema check: EventFilter has `type` (String) and `module`
 *   (String) — there is no multi-type filter, so we issue one connection per
 *   type in a single aliased query and merge.)
 *
 * Pagination: each type paginates independently (backward via `last`/`before`;
 * `pageInfo.startCursor` walks into older history). The page cursor we hand back
 * to react-query is a composite of every still-live type's cursor; a type whose
 * `hasPreviousPage` is false drops out of subsequent requests. Schema verified
 * against graphql.mainnet.sui.io.
 */

import { CDPM, POOL } from "./cdpm";

const GRAPHQL_URL = "https://graphql.mainnet.sui.io/graphql";

export type AgentEventKind =
  | "AgentLiquidityAdded"
  | "AgentLiquidityRemoved"
  | "AgentFeeCollected"
  | "AgentRewardCollected";

const AGENT_KINDS: readonly AgentEventKind[] = [
  "AgentLiquidityAdded",
  "AgentLiquidityRemoved",
  "AgentFeeCollected",
  "AgentRewardCollected",
];

/** Fully-qualified event type string for each kind, on the current package. */
const TYPE_OF: Record<AgentEventKind, string> = {
  AgentLiquidityAdded: `${CDPM.PACKAGE_ID}::cdpm::AgentLiquidityAdded`,
  AgentLiquidityRemoved: `${CDPM.PACKAGE_ID}::cdpm::AgentLiquidityRemoved`,
  AgentFeeCollected: `${CDPM.PACKAGE_ID}::cdpm::AgentFeeCollected`,
  AgentRewardCollected: `${CDPM.PACKAGE_ID}::cdpm::AgentRewardCollected`,
};

export interface AgentOnchainEvent {
  kind: AgentEventKind;
  digest: string;
  timestampMs: number;
  agent: string;
  pmId: string;
  poolId: string;
  bins?: number[];
  amountA?: string;
  amountB?: string;
  amount?: string;
  coinType?: string;
  coinTypeA?: string;
  coinTypeB?: string;
}

export interface AgentEventsPage {
  events: AgentOnchainEvent[];
  /** Opaque composite cursor — pass as `before` to load the next-older page. */
  cursor: string | null;
  hasMore: boolean;
}

/** Per-kind pagination state, serialized into the opaque `before` cursor. */
interface CursorState {
  c: Partial<Record<AgentEventKind, string | null>>;
  done: Partial<Record<AgentEventKind, boolean>>;
}

interface RawNode {
  sender?: { address?: string } | null;
  timestamp?: string | null;
  transaction?: { digest?: string } | null;
  contents?: { type?: { repr?: string } | null; json?: Record<string, unknown> } | null;
}

interface RawConn {
  pageInfo?: { hasPreviousPage?: boolean; startCursor?: string | null } | null;
  nodes?: RawNode[] | null;
}

function shortType(repr: string): string {
  return repr.split("::").pop() ?? repr;
}

function decodeNode(n: RawNode): AgentOnchainEvent | null {
  const kind = shortType(n.contents?.type?.repr ?? "") as AgentEventKind;
  if (!AGENT_KINDS.includes(kind)) return null;
  const digest = n.transaction?.digest;
  if (!digest) return null;
  const j = (n.contents?.json ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (v == null ? undefined : String(v));

  const ev: AgentOnchainEvent = {
    kind,
    digest,
    timestampMs: n.timestamp ? Date.parse(n.timestamp) : 0,
    agent: n.sender?.address ?? "",
    pmId: str(j.pm_id) ?? "",
    poolId: str(j.pool_id) ?? "",
  };
  if (kind === "AgentLiquidityAdded" || kind === "AgentLiquidityRemoved") {
    ev.bins = Array.isArray(j.bins) ? (j.bins as unknown[]).map((b) => Number(b)) : [];
    ev.amountA = str(j.amount_a);
    ev.amountB = str(j.amount_b);
  } else if (kind === "AgentFeeCollected") {
    ev.amountA = str(j.amount_a);
    ev.amountB = str(j.amount_b);
    ev.coinTypeA = str(j.coin_type_a);
    ev.coinTypeB = str(j.coin_type_b);
  } else if (kind === "AgentRewardCollected") {
    ev.amount = str(j.amount);
    ev.coinType = str(j.coin_type);
  }
  return ev;
}

export async function fetchAgentEvents(
  opts: { before?: string | null; pageSize?: number } = {},
): Promise<AgentEventsPage> {
  const pageSize = opts.pageSize ?? 20;
  const state: CursorState = opts.before
    ? (JSON.parse(opts.before) as CursorState)
    : { c: {}, done: {} };

  // Only query kinds that still have older history to walk.
  const active = AGENT_KINDS.filter((k) => !state.done[k]);
  if (active.length === 0) return { events: [], cursor: null, hasMore: false };

  // One aliased `events` connection per active kind, each with its own type
  // filter and backward cursor. Single round-trip.
  const varDefs = active.map((_, i) => `$t${i}: String!, $b${i}: String`).join(", ");
  const fields = active
    .map(
      (_, i) => `a${i}: events(last: $n, before: $b${i}, filter: { type: $t${i} }) {
      pageInfo { hasPreviousPage startCursor }
      nodes { sender { address } timestamp transaction { digest } contents { type { repr } json } }
    }`,
    )
    .join("\n");
  const query = `query($n: Int!, ${varDefs}) {\n${fields}\n}`;

  const variables: Record<string, unknown> = { n: pageSize };
  active.forEach((k, i) => {
    variables[`t${i}`] = TYPE_OF[k];
    variables[`b${i}`] = state.c[k] ?? null;
  });

  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Sui GraphQL HTTP ${res.status}`);
  const body = (await res.json()) as {
    data?: Record<string, RawConn | undefined>;
    errors?: unknown;
  };
  if (body.errors) throw new Error(`Sui GraphQL error: ${JSON.stringify(body.errors)}`);

  const events: AgentOnchainEvent[] = [];
  const nextC: CursorState["c"] = { ...state.c };
  const nextDone: CursorState["done"] = { ...state.done };

  active.forEach((k, i) => {
    const conn = body.data?.[`a${i}`];
    const nodes = conn?.nodes ?? [];
    for (const nd of nodes) {
      const ev = decodeNode(nd);
      if (ev) events.push(ev);
    }
    if (!conn?.pageInfo?.hasPreviousPage || nodes.length === 0) {
      nextDone[k] = true; // exhausted — stop querying this kind
    } else {
      nextC[k] = conn.pageInfo.startCursor ?? null;
    }
  });

  events.sort((a, b) => b.timestampMs - a.timestampMs); // newest first
  const hasMore = AGENT_KINDS.some((k) => !nextDone[k]);
  const cursor = hasMore ? JSON.stringify({ c: nextC, done: nextDone }) : null;
  return { events, cursor, hasMore };
}

/** Human one-liner for an event's amounts, using the single pool's decimals. */
export function eventAmountLabel(e: AgentOnchainEvent): string {
  const a = (raw?: string) => (Number(raw ?? "0") / 10 ** POOL.decimalsA).toLocaleString("en-US", { maximumFractionDigits: 2 });
  const b = (raw?: string) => (Number(raw ?? "0") / 10 ** POOL.decimalsB).toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (e.kind === "AgentLiquidityAdded" || e.kind === "AgentLiquidityRemoved") {
    return `${e.bins?.length ?? 0} bins · ${a(e.amountA)} ${POOL.symbolA} / ${b(e.amountB)} ${POOL.symbolB}`;
  }
  if (e.kind === "AgentFeeCollected") {
    return `${a(e.amountA)} ${POOL.symbolA} / ${b(e.amountB)} ${POOL.symbolB}`;
  }
  return `${e.amount ?? "0"} (${shortType(e.coinType ?? "")})`;
}
