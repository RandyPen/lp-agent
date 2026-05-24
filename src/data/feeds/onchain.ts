/**
 * On-chain price feed: derives price observations from recent Cetus DLMM swap
 * events for a configured pool.
 *
 * SwapEvent payload (Cetus DLMM SDK v1.2.6, mainnet):
 *   {
 *     pool:       string,           // pool object id
 *     bin_swaps:  Array<{
 *       bin_id: { bits: number },   // signed I32 encoded as { bits }
 *       ...
 *     }>,
 *     ...
 *   }
 *
 * The last bin_swap entry is where the swap settled (active bin post-swap).
 * timestampMs is on the SuiEvent envelope, not in parsedJson.
 */

import type { SuiEvent } from "@mysten/sui/jsonRpc";
import type { PriceFeed } from "../priceFeed.ts";
import type { PoolProfile } from "../../pools/types.ts";
import type { PriceObservation } from "../../domain/types.ts";
import type { OhlcvBar } from "../../forecast/types.ts";
import { bucketToOhlcv } from "../../forecast/garch.ts";
import { priceFromBinId } from "../../domain/binMath.ts";
import { getSuiClient } from "../../sui/client.ts";
import { getDb } from "../../db/client.ts";
import { PriceFeedError } from "../../lib/errors.ts";
import { log } from "../../lib/logger.ts";

// Mainnet package id for the Cetus DLMM pool module (sdk v1.2.6).
const DLMM_PACKAGE_MAINNET =
  "0x5664f9d3fd82c84023870cfbda8ea84e14c8dd56ce557ad2116e0668581a682b";

// Spot cache TTL: re-fetch RPC at most once per second for consecutive getSpot() calls.
const SPOT_CACHE_TTL_MS = 1_500;

// How many events to fetch per page when building history.
const PAGE_LIMIT = 50;

// Hard cap on history pagination — prevents a runaway crawl on heavy pools
// from consuming arbitrary RPC quota. At 50 events per page × 50 pages this
// is up to 2,500 swap events per `getHistory()` call, which covers ~hours of
// activity on the busiest mainnet pools.
const HISTORY_MAX_PAGES = 50;

// ---- internal types --------------------------------------------------------

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

// ---- helpers ----------------------------------------------------------------

function isRawSwapEvent(v: unknown): v is RawSwapEvent {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj["pool"] === "string" &&
    Array.isArray(obj["bin_swaps"]) &&
    (obj["bin_swaps"] as unknown[]).length > 0
  );
}

/**
 * Extract a PriceObservation from a SuiEvent whose type contains
 * "pool::SwapEvent". Returns null if the event doesn't match the configured
 * poolId or if the payload shape is unexpected.
 */
function observationFromSwapEvent(
  event: SuiEvent,
  profile: PoolProfile,
): PriceObservation | null {
  if (!event.type.includes("pool::SwapEvent")) return null;

  const raw = event.parsedJson;
  if (!isRawSwapEvent(raw)) {
    log.warn("onchain-feed: unexpected SwapEvent payload shape", { type: event.type });
    return null;
  }

  // Filter to this pool only.
  if (raw.pool !== profile.poolId) return null;

  // The last bin_swap entry is the bin the swap settled in (active bin post-swap).
  const lastBinSwap = raw.bin_swaps[raw.bin_swaps.length - 1];
  if (lastBinSwap === undefined) return null;

  // bin_id.bits is a u32 bit-pattern of a signed I32; reinterpret as signed.
  const bits = lastBinSwap.bin_id.bits;
  // Safe: I32 range fits in a JS number; no BigInt needed here.
  const binId = bits >= 0x80000000 ? bits - 0x100000000 : bits;

  const price = priceFromBinId(binId, profile.binStep, profile.decimalsA, profile.decimalsB);

  // timestampMs is on the SuiEvent envelope (string | null | undefined).
  const tsRaw = event.timestampMs;
  const timestampMs = tsRaw != null ? Number(tsRaw) : Date.now();

  return {
    price,
    timestampMs,
    source: `onchain:${profile.poolId}`,
  };
}

// ---- factory ----------------------------------------------------------------

function persistObservation(profile: PoolProfile, obs: PriceObservation): void {
  let db;
  try {
    db = getDb();
  } catch {
    // DB not initialised yet (e.g. in unit tests). Skip silently.
    return;
  }
  try {
    db.prepare(
      `INSERT INTO price_observations (pool_id, source, price, observed_ms) VALUES (?, ?, ?, ?)`,
    ).run(profile.poolId, obs.source, obs.price, obs.timestampMs);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("onchain-feed: failed to persist observation", { error: msg });
  }
}

interface OhlcvRow {
  price: string;
  observed_ms: number;
}

function readOhlcvFromDb(
  profile: PoolProfile,
  bucketMs: number,
  windowMs: number,
): OhlcvBar[] {
  let db;
  try {
    db = getDb();
  } catch {
    return [];
  }
  const cutoff = Date.now() - windowMs;
  const rows = db
    .query<OhlcvRow, [string, number]>(
      `SELECT price, observed_ms FROM price_observations
       WHERE pool_id = ? AND observed_ms >= ?
       ORDER BY observed_ms ASC`,
    )
    .all(profile.poolId, cutoff);
  return bucketToOhlcv(
    rows.map((r) => ({ timestampMs: r.observed_ms, price: Number(r.price) })),
    bucketMs,
  );
}

export function createOnchainPriceFeed(profile: PoolProfile): PriceFeed {
  const source = `onchain:${profile.poolId}`;

  // Spot cache.
  let cachedSpot: PriceObservation | null = null;
  let cacheExpiresAt = 0;

  async function fetchLatestObservation(): Promise<PriceObservation> {
    const client = getSuiClient();

    // Query the most recent swap events for this pool's package, descending.
    let page;
    try {
      page = await client.queryEvents({
        query: { MoveEventType: `${DLMM_PACKAGE_MAINNET}::pool::SwapEvent` },
        limit: PAGE_LIMIT,
        order: "descending",
      });
    } catch (err) {
      throw new PriceFeedError(
        `${source}: queryEvents failed`,
        err,
      );
    }

    for (const event of page.data) {
      const obs = observationFromSwapEvent(event, profile);
      if (obs !== null) return obs;
    }

    throw new PriceFeedError(
      `${source}: no recent SwapEvent found for pool ${profile.poolId}`,
    );
  }

  async function getHistory(windowMs: number): Promise<PriceObservation[]> {
    const client = getSuiClient();
    const cutoff = Date.now() - windowMs;
    const results: PriceObservation[] = [];

    let cursor: { txDigest: string; eventSeq: string } | null | undefined = null;
    let exhausted = false;
    let pages = 0;

    while (!exhausted) {
      if (pages >= HISTORY_MAX_PAGES) {
        log.warn(`${source}: getHistory hit pagination cap`, { pages, windowMs });
        break;
      }
      pages += 1;
      let page;
      try {
        page = await client.queryEvents({
          query: { MoveEventType: `${DLMM_PACKAGE_MAINNET}::pool::SwapEvent` },
          cursor,
          limit: PAGE_LIMIT,
          order: "descending",
        });
      } catch (err) {
        throw new PriceFeedError(`${source}: queryEvents failed during history fetch`, err);
      }

      for (const event of page.data) {
        // timestampMs may be null on some RPC nodes; fall back gracefully.
        const tsRaw = event.timestampMs;
        if (tsRaw == null) {
          log.warn(`${source}: event missing timestampMs, skipping history entry`);
          continue;
        }
        const ts = Number(tsRaw);
        if (ts < cutoff) {
          exhausted = true;
          break;
        }

        const obs = observationFromSwapEvent(event, profile);
        if (obs !== null) results.push(obs);
      }

      if (!page.hasNextPage || page.nextCursor == null) exhausted = true;
      else cursor = page.nextCursor;
    }

    // Events were fetched descending; reverse so callers get oldest-first.
    results.reverse();

    // Best-effort persistence so future getOhlcv() calls have history to bucket.
    for (const obs of results) persistObservation(profile, obs);

    return results;
  }

  return {
    source,

    async getSpot(): Promise<PriceObservation> {
      const now = Date.now();
      if (cachedSpot !== null && now < cacheExpiresAt) return cachedSpot;

      const obs = await fetchLatestObservation();
      cachedSpot = obs;
      cacheExpiresAt = now + SPOT_CACHE_TTL_MS;
      persistObservation(profile, obs);
      return obs;
    },

    getHistory,

    async getOhlcv(bucketMs: number, windowMs: number): Promise<OhlcvBar[]> {
      // Lazy-fill: top up SQLite from chain so the first calls aren't empty.
      // Tolerant of failures — returns whatever buckets are already available.
      try {
        await getHistory(windowMs);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`${source}: getHistory failed during getOhlcv top-up`, { error: msg });
      }
      return readOhlcvFromDb(profile, bucketMs, windowMs);
    },
  };
}
