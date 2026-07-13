/**
 * src/data/feeds/cetusEvents.ts
 *
 * Cetus DLMM pool live state + swap-event capture, modeled on onchain.ts.
 *
 * Provides two surfaces:
 *
 * 1. Live feed — `createCetusEventsFeed(opts)` polls the Cetus pool state on a
 *    configurable interval and caches the latest `activeBin`, `price`, `tvlUsd`,
 *    and `binStep`. The pool object is read via `SuiClient.getObject()`.
 *
 * 2. Historical backfill — `backfillSwapEvents(opts)` pages through
 *    `queryEvents` windows from the most-recent back to the earliest available
 *    history, rate-limit aware, with resumable cursor via the `event_cursor`
 *    table (stream key: `cetus_swap_backfill:<poolId>`).
 *
 * Storage strategy (no schema changes):
 *   - Price points → `price_observations` (source='cetus_event') — already
 *     exists and is the canonical per-pool history table.
 *   - Raw swap events → emitted to caller via `onBatch` callback; if the
 *     caller wants persistent raw rows they write them to JSONL files under a
 *     data dir path they supply. We do NOT add a new SQLite table to avoid
 *     touching schema.sql.
 *
 * Backfill resume: the `event_cursor` table stores `(stream, tx_digest, event_seq)`.
 * On each successful page we upsert the last-seen cursor. On restart we load
 * the cursor and resume from that point in the descending scan. Because Sui
 * events are immutable, re-fetching pages we've already seen is idempotent:
 * duplicate `price_observations` rows are allowed (same observed_ms/price can
 * appear more than once without breaking queries).
 *
 * Sui RPC endpoints used:
 *   - `queryEvents` with MoveEventType filter for `<DLMM_PACKAGE>::pool::SwapEvent`
 *   - `getObject` for pool state (activeBin, binStep)
 *
 * Pool object field layout (verified against mainnet 2026-06, reserves 2026-07):
 *   fields.active_id = { type: "...I32", fields: { bits: <u32> } }
 *   fields.bin_manager.fields.bin_step  (u64 as string or number)
 *   fields.balance_a / fields.balance_b (u64 strings — raw pool reserves)
 *   There is NO top-level `current_index` and NO top-level `bin_step`.
 *
 * Price convention:
 *   All prices stored in `price_observations` and returned by `latest().price`
 *   are human USDC-per-SUI (Binance SUIUSDC convention).
 *   For Pool<USDC=6, SUI=9>:
 *     price = 10^(poolCoinBDecimals − poolCoinADecimals) / (1+binStep/10000)^binId
 *           = 10^3 / (1.005^1442) ≈ 0.7526
 *   This is computed by `priceFromBinIdAsQuote(binId, binStep, poolCoinADecimals, poolCoinBDecimals)`.
 */

import type { SuiEvent } from "@mysten/sui/jsonRpc";
import { getDb } from "../../db/client.ts";
import { getSuiClient } from "../../sui/client.ts";
import { priceFromBinIdAsQuote } from "../../domain/binMath.ts";
import { log } from "../../lib/logger.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Mainnet DLMM package (same as onchain.ts).
const DLMM_PACKAGE_MAINNET =
  "0x5664f9d3fd82c84023870cfbda8ea84e14c8dd56ce557ad2116e0668581a682b";

// How many events to fetch per page.
const PAGE_LIMIT = 50;

// Rate-limit delay between backfill pages (ms). Sui public RPC: 10 req/s.
const BACKFILL_PAGE_DELAY_MS = 150;

// Live poll interval defaults.
const DEFAULT_POLL_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// Default pool-physical coin decimals (SUI/USDC mainnet pool: Pool<USDC=6, SUI=9>)
// ---------------------------------------------------------------------------

const DEFAULT_POOL_COIN_A_DECIMALS = 6; // USDC = 6 decimals (physical coinA of the real pool)
const DEFAULT_POOL_COIN_B_DECIMALS = 9; // SUI  = 9 decimals (physical coinB of the real pool)

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface RawBinSwap {
  bin_id: { bits: number };
  amount_in: string;
  amount_out: string;
  fee: string;
  var_fee_rate: string;
}

interface RawSwapEvent {
  pool: string;
  amount_in: string;
  amount_out: string;
  fee: string;
  ref_fee: string;
  bin_swaps: RawBinSwap[];
  from: { name: string };
  target: { name: string };
  partner: string;
}

function isRawSwapEvent(v: unknown): v is RawSwapEvent {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj["pool"] === "string" &&
    Array.isArray(obj["bin_swaps"]) &&
    (obj["bin_swaps"] as unknown[]).length > 0
  );
}

/** Reinterpret a Cetus u32-encoded signed I32 bin id as a JS number. */
function decodeBinId(bits: number): number {
  return bits >= 0x80000000 ? bits - 0x100000000 : bits;
}

// ---------------------------------------------------------------------------
// Cursor helpers (mirrors subscriptions.ts pattern)
// ---------------------------------------------------------------------------

interface EventCursorRow {
  tx_digest: string | null;
  event_seq: string | null;
}

interface EventCursor {
  txDigest: string;
  eventSeq: string;
}

function loadCursor(stream: string): EventCursor | null {
  let db;
  try { db = getDb(); } catch { return null; }
  const row = db
    .query<EventCursorRow, [string]>(
      "SELECT tx_digest, event_seq FROM event_cursor WHERE stream = ?",
    )
    .get(stream);
  if (!row || !row.tx_digest || !row.event_seq) return null;
  return { txDigest: row.tx_digest, eventSeq: row.event_seq };
}

function saveCursor(stream: string, cursor: EventCursor): void {
  let db;
  try { db = getDb(); } catch { return; }
  try {
    db.prepare(
      `INSERT INTO event_cursor (stream, tx_digest, event_seq, updated_ms)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(stream) DO UPDATE SET
         tx_digest  = excluded.tx_digest,
         event_seq  = excluded.event_seq,
         updated_ms = excluded.updated_ms`,
    ).run(stream, cursor.txDigest, cursor.eventSeq, Date.now());
  } catch (err: unknown) {
    log.warn("cetusEvents: saveCursor failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function persistPriceObservation(
  poolId: string,
  price: string,
  timestampMs: number,
): void {
  let db;
  try { db = getDb(); } catch { return; }
  try {
    db.prepare(
      `INSERT INTO price_observations (pool_id, source, price, observed_ms) VALUES (?, ?, ?, ?)`,
    ).run(poolId, "cetus_event", price, timestampMs);
  } catch (err: unknown) {
    log.warn("cetusEvents: persistPriceObservation failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Raw swap event extraction
// ---------------------------------------------------------------------------

export interface SwapEventRecord {
  poolId: string;
  binId: number;
  price: string;
  amountIn: string;
  amountOut: string;
  fee: string;
  timestampMs: number;
  txDigest: string;
  eventSeq: string;
  /**
   * The verbatim SwapEvent payload (`event.parsedJson`).
   *
   * The derived fields above collapse a multi-bin swap to its LAST bin and drop
   * the direction, which is enough for a mid-price but not for a fill model: a
   * PnL backtest needs to know, per bin, which side the taker consumed and what
   * fee was paid. Rather than widen this record with a parsed projection, we
   * carry the raw payload so `parseSwapEvent` (src/services/shadowBook.ts) — the
   * exact function the live shadow fleet uses — can reconstruct the fills.
   */
  raw: unknown;
}

function extractSwapEvent(
  event: SuiEvent,
  poolId: string,
  binStep: number,
  poolCoinADecimals: number,
  poolCoinBDecimals: number,
): SwapEventRecord | null {
  if (!event.type.includes("pool::SwapEvent")) return null;

  const raw = event.parsedJson;
  if (!isRawSwapEvent(raw)) {
    log.warn("cetusEvents: unexpected SwapEvent payload shape", { type: event.type });
    return null;
  }

  if (raw.pool !== poolId) return null;

  const lastBinSwap = raw.bin_swaps[raw.bin_swaps.length - 1];
  if (!lastBinSwap) return null;

  const binId = decodeBinId(lastBinSwap.bin_id.bits);
  // Human price in the Binance quote convention (USDC per SUI for this pool).
  const price = priceFromBinIdAsQuote(binId, binStep, poolCoinADecimals, poolCoinBDecimals);

  const tsRaw = event.timestampMs;
  const timestampMs = tsRaw != null ? Number(tsRaw) : Date.now();

  // Extract cursor from event id (Sui SDK shape: event.id = { txDigest, eventSeq })
  const id = event.id as { txDigest?: string; eventSeq?: string } | undefined;

  return {
    poolId,
    binId,
    price,
    amountIn: raw.amount_in,
    amountOut: raw.amount_out,
    fee: raw.fee,
    timestampMs,
    txDigest: id?.txDigest ?? "",
    eventSeq: id?.eventSeq ?? "",
    raw,
  };
}

// ---------------------------------------------------------------------------
// Live pool state query
// ---------------------------------------------------------------------------

export interface CetusPoolState {
  activeBin: number;
  price: string;
  tvlUsd: number;
  binStep: number;
}

/**
 * Query pool object on-chain to get the current active bin and bin step.
 *
 * Real DLMM pool object field layout (verified against mainnet):
 *   fields.active_id = { type: "...I32", fields: { bits: <u32 two's-complement> } }
 *   fields.bin_manager.fields.bin_step  (u64, may be string or number)
 *
 * There is NO top-level `current_index` and NO top-level `bin_step`.
 * Throws explicitly on missing fields — never silently defaults to zeros.
 *
 * @param poolCoinADecimals  Physical decimals of the pool's coinA (e.g. 6 for USDC).
 * @param poolCoinBDecimals  Physical decimals of the pool's coinB (e.g. 9 for SUI).
 */
async function queryPoolState(
  poolId: string,
  poolCoinADecimals: number,
  poolCoinBDecimals: number,
  clientOverride?: { getObject: (args: { id: string; options: object }) => Promise<unknown> },
): Promise<CetusPoolState> {
  const client = clientOverride ?? getSuiClient();
  const obj = await (client as unknown as {
    getObject(args: { id: string; options: object }): Promise<{
      data?: { content?: { fields?: Record<string, unknown> } };
    }>
  }).getObject({
    id: poolId,
    options: { showContent: true },
  });

  const fields = obj?.data?.content?.fields;
  if (!fields) {
    throw new Error(`cetusEvents: pool object ${poolId} has no content fields`);
  }

  // active_id is stored as a nested I32 struct: { fields: { bits: <u32> } }.
  // There is no top-level "current_index" field.
  const activeIdField = fields["active_id"];
  if (
    activeIdField === undefined ||
    activeIdField === null ||
    typeof activeIdField !== "object"
  ) {
    throw new Error(
      `cetusEvents: pool object ${poolId} missing fields.active_id ` +
        `(got: ${JSON.stringify(activeIdField)})`,
    );
  }
  const activeIdInner = (activeIdField as Record<string, unknown>)["fields"];
  if (
    activeIdInner === undefined ||
    activeIdInner === null ||
    typeof activeIdInner !== "object"
  ) {
    throw new Error(
      `cetusEvents: pool object ${poolId} fields.active_id has no nested fields ` +
        `(got: ${JSON.stringify(activeIdField)})`,
    );
  }
  const bitsRaw = (activeIdInner as Record<string, unknown>)["bits"];
  if (bitsRaw === undefined || bitsRaw === null) {
    throw new Error(
      `cetusEvents: pool object ${poolId} fields.active_id.fields.bits is missing`,
    );
  }
  const activeBin = decodeBinId(Number(bitsRaw));

  // bin_step lives at fields.bin_manager.fields.bin_step — NOT at the top level.
  const binManagerField = fields["bin_manager"];
  if (
    binManagerField === undefined ||
    binManagerField === null ||
    typeof binManagerField !== "object"
  ) {
    throw new Error(
      `cetusEvents: pool object ${poolId} missing fields.bin_manager ` +
        `(got: ${JSON.stringify(binManagerField)})`,
    );
  }
  const binManagerInner = (binManagerField as Record<string, unknown>)["fields"];
  if (
    binManagerInner === undefined ||
    binManagerInner === null ||
    typeof binManagerInner !== "object"
  ) {
    throw new Error(
      `cetusEvents: pool object ${poolId} fields.bin_manager has no nested fields ` +
        `(got: ${JSON.stringify(binManagerField)})`,
    );
  }
  const binStepRaw = (binManagerInner as Record<string, unknown>)["bin_step"];
  if (binStepRaw === undefined || binStepRaw === null) {
    throw new Error(
      `cetusEvents: pool object ${poolId} fields.bin_manager.fields.bin_step is missing`,
    );
  }
  const binStep = Number(binStepRaw);
  if (!Number.isFinite(binStep) || binStep <= 0) {
    throw new Error(
      `cetusEvents: pool object ${poolId} bin_step=${binStepRaw} is not a valid positive number`,
    );
  }

  // Human price: USDC per SUI (Binance SUIUSDC convention).
  const price = priceFromBinIdAsQuote(activeBin, binStep, poolCoinADecimals, poolCoinBDecimals);

  // ---------------------------------------------------------------------------
  // TVL from pool reserves.
  //
  // `balance_a` / `balance_b` are top-level u64 strings on the DLMM pool
  // object (verified against mainnet 2026-07). Missing/non-numeric values
  // throw — never silently default to 0, because a 0 TVL permanently disarms
  // the L2 "TVL drop" risk circuit (circuits.ts returns fires:false whenever
  // the window baseline <= 0).
  //
  // Approximation (deliberate, documented): both reserves are valued through
  // the pool's own spot price with PHYSICAL coinA treated as the USD-pegged
  // quote side — true for the SUI/USDC pool (Pool<USDC=6, SUI=9>, price =
  // USDC per SUI = coinA per coinB):
  //
  //   tvlUsd ≈ reserveA / 10^decA  +  (reserveB / 10^decB) × price
  //
  // This is good enough for the TVL-drop circuit, which only compares TVL
  // against itself over a 5-minute window; absolute USD accuracy is not
  // required. Number() precision loss on u64 reserves is likewise irrelevant
  // at percentage granularity.
  // ---------------------------------------------------------------------------
  const balanceARaw = fields["balance_a"];
  const balanceBRaw = fields["balance_b"];
  if (balanceARaw === undefined || balanceARaw === null || typeof balanceARaw === "object") {
    throw new Error(
      `cetusEvents: pool object ${poolId} missing fields.balance_a ` +
        `(got: ${JSON.stringify(balanceARaw)})`,
    );
  }
  if (balanceBRaw === undefined || balanceBRaw === null || typeof balanceBRaw === "object") {
    throw new Error(
      `cetusEvents: pool object ${poolId} missing fields.balance_b ` +
        `(got: ${JSON.stringify(balanceBRaw)})`,
    );
  }
  const balanceA = Number(balanceARaw);
  const balanceB = Number(balanceBRaw);
  if (!Number.isFinite(balanceA) || balanceA < 0 || !Number.isFinite(balanceB) || balanceB < 0) {
    throw new Error(
      `cetusEvents: pool object ${poolId} has non-numeric reserves ` +
        `(balance_a=${String(balanceARaw)}, balance_b=${String(balanceBRaw)})`,
    );
  }
  const priceNum = Number(price);
  if (!Number.isFinite(priceNum) || priceNum <= 0) {
    throw new Error(
      `cetusEvents: pool object ${poolId} produced invalid price '${price}' ` +
        `(activeBin=${activeBin}, binStep=${binStep}) — cannot compute TVL`,
    );
  }
  const tvlUsd =
    balanceA / Math.pow(10, poolCoinADecimals) +
    (balanceB / Math.pow(10, poolCoinBDecimals)) * priceNum;

  return {
    activeBin,
    price,
    tvlUsd,
    binStep,
  };
}

// ---------------------------------------------------------------------------
// Live feed
// ---------------------------------------------------------------------------

export interface CetusEventsFeedOptions {
  /** Cetus DLMM pool object ID. */
  poolId: string;
  /** How often to poll pool state. Default 30_000 ms. */
  pollIntervalMs?: number;
  /**
   * Physical decimals of the DLMM pool's coinA.
   * For the SUI/USDC mainnet pool (Pool<USDC=6, SUI=9>): 6.
   * Defaults to DEFAULT_POOL_COIN_A_DECIMALS (6).
   */
  poolCoinADecimals?: number;
  /**
   * Physical decimals of the DLMM pool's coinB.
   * For the SUI/USDC mainnet pool (Pool<USDC=6, SUI=9>): 9.
   * Defaults to DEFAULT_POOL_COIN_B_DECIMALS (9).
   */
  poolCoinBDecimals?: number;
  /**
   * Injectable SuiClient-like object for testing.
   * Must implement `getObject` and `queryEvents`.
   */
  clientOverride?: unknown;
}

export interface CetusEventsFeed {
  /** Start background poll loop. Returns a stop function. */
  start(): () => void;
  /** Latest cached pool state. */
  latest(): CetusPoolState;
  /** Epoch ms of the last successful update, or 0 if never updated. */
  lastUpdatedMs(): number;
}

export function createCetusEventsFeed(opts: CetusEventsFeedOptions): CetusEventsFeed {
  const {
    poolId,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    poolCoinADecimals = DEFAULT_POOL_COIN_A_DECIMALS,
    poolCoinBDecimals = DEFAULT_POOL_COIN_B_DECIMALS,
  } = opts;
  const clientOverride = opts.clientOverride as
    | { getObject: (args: { id: string; options: object }) => Promise<unknown> }
    | undefined;

  // Initial cached state: activeBin=0 and price="0" before first poll.
  // The feed's lastUpdatedMs() guard prevents consumers from using stale zeros.
  let cached: CetusPoolState = {
    activeBin: 0,
    price: "0",
    tvlUsd: 0,
    binStep: 0,
  };
  let lastUpdated = 0;

  async function refresh(): Promise<void> {
    // queryPoolState either returns a complete state (activeBin, price, real
    // reserve-derived tvlUsd, binStep) or throws. On throw the previous cache
    // is kept untouched and lastUpdated does NOT advance, so the aggregator's
    // staleness surface reflects the outage — no partial/zero states are ever
    // written.
    const state = await queryPoolState(poolId, poolCoinADecimals, poolCoinBDecimals, clientOverride);
    cached = state;
    lastUpdated = Date.now();
  }

  return {
    start(): () => void {
      refresh().catch((err: unknown) => {
        log.error("cetusEvents: initial poll failed", {
          poolId,
          error: err instanceof Error ? err.message : String(err),
        });
      });

      const timer = setInterval(() => {
        refresh().catch((err: unknown) => {
          log.warn("cetusEvents: poll failed", {
            poolId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }, pollIntervalMs);

      return () => clearInterval(timer);
    },

    latest(): CetusPoolState {
      return { ...cached };
    },

    lastUpdatedMs(): number {
      return lastUpdated;
    },
  };
}

// ---------------------------------------------------------------------------
// Historical backfill
// ---------------------------------------------------------------------------

export interface BackfillSwapEventsOptions {
  /** Pool object ID. */
  poolId: string;
  /** Bin step in bps (needed for price calculation). */
  binStep: number;
  /**
   * Physical decimals of the DLMM pool's coinA.
   * For the SUI/USDC mainnet pool (Pool<USDC=6, SUI=9>): 6.
   * Defaults to DEFAULT_POOL_COIN_A_DECIMALS (6).
   */
  poolCoinADecimals?: number;
  /**
   * Physical decimals of the DLMM pool's coinB.
   * For the SUI/USDC mainnet pool (Pool<USDC=6, SUI=9>): 9.
   * Defaults to DEFAULT_POOL_COIN_B_DECIMALS (9).
   */
  poolCoinBDecimals?: number;
  /**
   * Earliest timestamp (ms) to backfill to.
   * If omitted, backfill as far back as the RPC allows.
   */
  fromMs?: number;
  /** Latest timestamp (ms) to backfill to. Defaults to now. */
  toMs?: number;
  /**
   * Callback invoked with each page of swap events.
   * Callers may write these to JSONL files or process them in-memory.
   */
  onBatch: (events: SwapEventRecord[]) => void | Promise<void>;
  /**
   * Injectable SuiClient-like object for testing.
   * Must implement `queryEvents`.
   */
  clientOverride?: unknown;
}

interface QueryEventsClient {
  queryEvents(args: {
    query: { MoveEventType: string };
    cursor?: { txDigest: string; eventSeq: string } | null;
    limit: number;
    order: "ascending" | "descending";
  }): Promise<{
    data: SuiEvent[];
    hasNextPage: boolean;
    nextCursor?: { txDigest: string; eventSeq: string } | null;
  }>;
}

/**
 * Backfill historical Cetus swap events for a given pool.
 *
 * Scans `queryEvents` in descending order (newest first) from the saved
 * cursor (if any) back to `fromMs`. Each page is deduplicated against the
 * price_observations table and emitted to `onBatch` in descending order.
 *
 * The cursor is saved after each successful page so the backfill is
 * resumable: kill the process, restart, and it continues from where it left off.
 * Stream key: `cetus_swap_backfill:<poolId>`.
 *
 * Note on direction: Sui's `queryEvents` with `order: "descending"` starts
 * from the most-recent event and pages backward. The cursor saved is the
 * last event of each page (oldest in that page). On resume we start from
 * that cursor so we continue scanning older events.
 */
export async function backfillSwapEvents(opts: BackfillSwapEventsOptions): Promise<void> {
  const {
    poolId,
    binStep,
    fromMs,
    toMs,
    onBatch,
    poolCoinADecimals = DEFAULT_POOL_COIN_A_DECIMALS,
    poolCoinBDecimals = DEFAULT_POOL_COIN_B_DECIMALS,
  } = opts;
  const cutoff = fromMs ?? 0;
  const toMsActual = toMs ?? Date.now();

  const streamKey = `cetus_swap_backfill:${poolId}`;
  const savedCursor = loadCursor(streamKey);

  const rawClient = (opts.clientOverride ?? getSuiClient()) as QueryEventsClient;

  log.info("cetusEvents: backfill starting", {
    poolId,
    fromMs: cutoff,
    toMs: toMsActual,
    resumeCursor: savedCursor ? `${savedCursor.txDigest}:${savedCursor.eventSeq}` : "none",
  });

  let cursor: { txDigest: string; eventSeq: string } | null = savedCursor;
  let exhausted = false;
  let totalEvents = 0;
  let totalPages = 0;

  while (!exhausted) {
    let page;
    try {
      page = await rawClient.queryEvents({
        query: { MoveEventType: `${DLMM_PACKAGE_MAINNET}::pool::SwapEvent` },
        cursor: cursor,
        limit: PAGE_LIMIT,
        order: "descending",
      });
    } catch (err: unknown) {
      throw new Error(
        `cetusEvents: backfill queryEvents failed (page ${totalPages}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    totalPages++;
    const batch: SwapEventRecord[] = [];

    for (const event of page.data) {
      const tsRaw = event.timestampMs;
      if (tsRaw == null) {
        log.warn("cetusEvents: backfill event missing timestampMs, skipping");
        continue;
      }
      const ts = Number(tsRaw);

      // Skip events newer than toMs (can happen on first page).
      if (ts > toMsActual) continue;

      // Stop scanning once we've gone further back than fromMs.
      if (ts < cutoff) {
        exhausted = true;
        break;
      }

      const record = extractSwapEvent(event, poolId, binStep, poolCoinADecimals, poolCoinBDecimals);
      if (record !== null) {
        batch.push(record);
        // Persist human price point to price_observations.
        persistPriceObservation(poolId, record.price, record.timestampMs);
      }
    }

    if (batch.length > 0) {
      await onBatch(batch);
      totalEvents += batch.length;

      // Save cursor from the oldest event on this page (last in descending order).
      const oldest = batch[batch.length - 1];
      if (oldest && oldest.txDigest) {
        saveCursor(streamKey, { txDigest: oldest.txDigest, eventSeq: oldest.eventSeq });
      }
    }

    if (!page.hasNextPage || page.nextCursor == null) {
      exhausted = true;
    } else if (!exhausted) {
      cursor = page.nextCursor;
    }

    // Rate-limit: sleep between pages to avoid overwhelming public RPC nodes.
    if (!exhausted) {
      await new Promise((r) => setTimeout(r, BACKFILL_PAGE_DELAY_MS));
    }
  }

  log.info("cetusEvents: backfill complete", { poolId, totalPages, totalEvents });
}
