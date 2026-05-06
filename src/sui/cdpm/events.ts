import { getSuiClient } from "../client.ts";
import { EVENT_TYPES } from "./package.ts";
import { log } from "../../lib/logger.ts";
import type {
  DecodedCdpmEvent,
  EventCursor,
  CdpmEventPayload,
  PositionManagerCreatedPayload,
  AgentAddedPayload,
  AgentRemovedPayload,
  PositionManagerClosedPayload,
  AgentLiquidityAddedPayload,
  AgentLiquidityRemovedPayload,
  AgentFeeCollectedPayload,
  AgentRewardCollectedPayload,
} from "./types.ts";

export interface PollResult {
  events: DecodedCdpmEvent[];
  nextCursor: EventCursor | null;
}

// ---- decoding helpers ----

/** Coerce a value that arrives as string | number from JSON to bigint. */
function toBigInt(v: unknown): bigint {
  return BigInt(v as string | number);
}

/** Coerce a u32 vector element: arrives as a JS number from JSON. */
function toU32(v: unknown): number {
  return Number(v);
}

/**
 * Decode a raw `SuiEvent` (from queryEvents) into a typed DecodedCdpmEvent.
 * Returns null for unrecognised event types.
 *
 * The `parsedJson` field is the Move event payload serialised to JSON by the
 * RPC. u64/u128 fields arrive as decimal strings; u32 as JS numbers;
 * ID/address as hex strings prefixed with "0x".
 */
export function decodeEvent(raw: unknown): DecodedCdpmEvent | null {
  const ev = raw as {
    type?: string;
    id?: { txDigest?: string; eventSeq?: string };
    timestampMs?: string | number | null;
    parsedJson?: Record<string, unknown>;
  };

  const eventType = ev.type ?? "";
  const txDigest = ev.id?.txDigest ?? "";
  const eventSeq = ev.id?.eventSeq ?? "";
  const timestampMs =
    ev.timestampMs != null ? Number(ev.timestampMs) : 0;
  const p = ev.parsedJson ?? {};

  let payload: CdpmEventPayload | null = null;

  switch (eventType) {
    case EVENT_TYPES.PositionManagerCreated: {
      const data: PositionManagerCreatedPayload = {
        pmId: String(p["pm_id"] ?? ""),
        owner: String(p["owner"] ?? ""),
        poolId: String(p["pool_id"] ?? ""),
        // I32 fields arrive as { bits: number }
        lowerBinId: i32BitsToNumber(p["lower_bin_id"]),
        upperBinId: i32BitsToNumber(p["upper_bin_id"]),
        // vector<u128> arrives as string[]
        liquidityShares: ((p["liquidity_shares"] as unknown[]) ?? []).map((s) =>
          BigInt(s as string | number),
        ),
      };
      payload = { name: "PositionManagerCreated", data };
      break;
    }

    case EVENT_TYPES.AgentAdded: {
      const data: AgentAddedPayload = {
        pmId: String(p["pm_id"] ?? ""),
        agent: String(p["agent"] ?? ""),
      };
      payload = { name: "AgentAdded", data };
      break;
    }

    case EVENT_TYPES.AgentRemoved: {
      const data: AgentRemovedPayload = {
        pmId: String(p["pm_id"] ?? ""),
        agent: String(p["agent"] ?? ""),
      };
      payload = { name: "AgentRemoved", data };
      break;
    }

    case EVENT_TYPES.PositionManagerClosed: {
      const data: PositionManagerClosedPayload = {
        pmId: String(p["pm_id"] ?? ""),
        owner: String(p["owner"] ?? ""),
      };
      payload = { name: "PositionManagerClosed", data };
      break;
    }

    case EVENT_TYPES.AgentLiquidityAdded: {
      const data: AgentLiquidityAddedPayload = {
        pmId: String(p["pm_id"] ?? ""),
        poolId: String(p["pool_id"] ?? ""),
        // vector<u32> arrives as JS number[]
        bins: ((p["bins"] as unknown[]) ?? []).map(toU32),
        amountA: toBigInt(p["amount_a"] ?? 0),
        amountB: toBigInt(p["amount_b"] ?? 0),
        by: String(p["by"] ?? ""),
      };
      payload = { name: "AgentLiquidityAdded", data };
      break;
    }

    case EVENT_TYPES.AgentLiquidityRemoved: {
      const data: AgentLiquidityRemovedPayload = {
        pmId: String(p["pm_id"] ?? ""),
        poolId: String(p["pool_id"] ?? ""),
        bins: ((p["bins"] as unknown[]) ?? []).map(toU32),
        // vector<u128> arrives as string[]
        liquidityShares: ((p["liquidity_shares"] as unknown[]) ?? []).map((s) =>
          BigInt(s as string | number),
        ),
        amountA: toBigInt(p["amount_a"] ?? 0),
        amountB: toBigInt(p["amount_b"] ?? 0),
        by: String(p["by"] ?? ""),
      };
      payload = { name: "AgentLiquidityRemoved", data };
      break;
    }

    case EVENT_TYPES.AgentFeeCollected: {
      // coin_type_a/b are std::ascii::String; the RPC returns them as plain
      // strings with the "0x" prefix preserved.
      const data: AgentFeeCollectedPayload = {
        pmId: String(p["pm_id"] ?? ""),
        poolId: String(p["pool_id"] ?? ""),
        coinTypeA: String(p["coin_type_a"] ?? ""),
        coinTypeB: String(p["coin_type_b"] ?? ""),
        amountA: toBigInt(p["amount_a"] ?? 0),
        amountB: toBigInt(p["amount_b"] ?? 0),
        by: String(p["by"] ?? ""),
      };
      payload = { name: "AgentFeeCollected", data };
      break;
    }

    case EVENT_TYPES.AgentRewardCollected: {
      const data: AgentRewardCollectedPayload = {
        pmId: String(p["pm_id"] ?? ""),
        poolId: String(p["pool_id"] ?? ""),
        coinType: String(p["coin_type"] ?? ""),
        amount: toBigInt(p["amount"] ?? 0),
        by: String(p["by"] ?? ""),
      };
      payload = { name: "AgentRewardCollected", data };
      break;
    }

    default:
      log.debug("decodeEvent: unknown event type", { eventType });
      return null;
  }

  return {
    type: eventType,
    txDigest,
    eventSeq,
    timestampMs,
    payload,
  };
}

/**
 * Page through CDPM events of a single Move event type.
 *
 * Uses the JSON-RPC `queryEvents` endpoint with a `MoveEventType` filter.
 * Returns at most `pageSize` events in ascending order (oldest first).
 * The `nextCursor` can be persisted and passed back on the next poll to
 * resume from where we left off.
 */
export async function pollEvents(
  moveEventType: string,
  cursor: EventCursor | null,
  pageSize: number = 50,
): Promise<PollResult> {
  const client = getSuiClient();

  log.debug("pollEvents", { moveEventType, cursor, pageSize });

  const page = await client.queryEvents({
    query: { MoveEventType: moveEventType },
    cursor: cursor ?? undefined,
    limit: pageSize,
    order: "ascending",
  });

  const events: DecodedCdpmEvent[] = [];
  for (const raw of page.data) {
    const decoded = decodeEvent(raw);
    if (decoded !== null) {
      events.push(decoded);
    }
  }

  // The RPC cursor is `{ txDigest, eventSeq }` which matches our EventCursor.
  const nextCursor: EventCursor | null = page.hasNextPage && page.nextCursor
    ? { txDigest: page.nextCursor.txDigest, eventSeq: page.nextCursor.eventSeq }
    : null;

  log.debug("pollEvents done", {
    moveEventType,
    received: page.data.length,
    decoded: events.length,
    hasNextPage: page.hasNextPage,
  });

  return { events, nextCursor };
}

// ---- internal util ----

/**
 * Convert an on-chain I32 value (surfaced as `{ bits: number }`) to a signed
 * JS number using two's-complement reinterpretation.
 */
function i32BitsToNumber(raw: unknown): number {
  if (raw == null) return 0;
  const obj = raw as { bits?: unknown };
  const bits = (Number(obj.bits ?? 0)) >>> 0; // coerce to u32
  return bits & 0x8000_0000 ? bits - 0x1_0000_0000 : bits;
}
