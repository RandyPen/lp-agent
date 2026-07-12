/**
 * On-chain agent activity — queried DIRECTLY from Sui GraphQL (no backend).
 *
 * Every row is a real mainnet transaction. We filter by the cdpm module and
 * keep only the four Agent* event structs; this surfaces real agent activity
 * across ALL PositionManagers — including third-party agents that are not ours.
 *
 * Pagination: the GraphQL `events` connection returns the most-recent page for
 * `last: N`; `pageInfo.startCursor` + `before:` walks backward into older
 * history ("load more"). Schema verified against graphql.mainnet.sui.io:
 *   EventFilter.module (String, "<pkg>::cdpm"), Event.sender/timestamp,
 *   Event.transaction.digest, Event.contents.{type.repr, json}.
 */

import { CDPM, POOL } from "./cdpm";

const GRAPHQL_URL = "https://graphql.mainnet.sui.io/graphql";
const CDPM_MODULE = `${CDPM.PACKAGE_ID}::cdpm`;

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
  /** startCursor of this page — pass as `before` to load the next-older page. */
  cursor: string | null;
  hasMore: boolean;
}

const QUERY = `query($first: Int!, $before: String, $module: String!) {
  events(last: $first, before: $before, filter: { module: $module }) {
    pageInfo { hasPreviousPage startCursor }
    nodes {
      sender { address }
      timestamp
      transaction { digest }
      contents { type { repr } json }
    }
  }
}`;

interface RawNode {
  sender?: { address?: string } | null;
  timestamp?: string | null;
  transaction?: { digest?: string } | null;
  contents?: { type?: { repr?: string } | null; json?: Record<string, unknown> } | null;
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
  const first = opts.pageSize ?? 20;
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: QUERY,
      variables: { first, before: opts.before ?? null, module: CDPM_MODULE },
    }),
  });
  if (!res.ok) throw new Error(`Sui GraphQL HTTP ${res.status}`);
  const body = (await res.json()) as {
    data?: {
      events?: {
        pageInfo?: { hasPreviousPage?: boolean; startCursor?: string | null };
        nodes?: RawNode[];
      };
    };
    errors?: unknown;
  };
  if (body.errors) throw new Error(`Sui GraphQL error: ${JSON.stringify(body.errors)}`);
  const conn = body.data?.events;
  const events = (conn?.nodes ?? [])
    .map(decodeNode)
    .filter((e): e is AgentOnchainEvent => e !== null)
    .sort((a, b) => b.timestampMs - a.timestampMs); // newest first
  return {
    events,
    cursor: conn?.pageInfo?.startCursor ?? null,
    hasMore: !!conn?.pageInfo?.hasPreviousPage,
  };
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
