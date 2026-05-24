/**
 * Binance price feed (public REST, no auth).
 *
 * Pulls spot from `/api/v3/ticker/price` and OHLCV from `/api/v3/klines` for
 * a configured pair (default SUIUSDC). Persisted into `price_observations`
 * with `source='binance:<SYMBOL>'` so the on-chain and CEX paths share a
 * history table — useful for both backtest and live blends.
 *
 * Caveats (read before deploying as your primary feed):
 *   - CEX price ≠ on-chain pool price. Expect a systematic gap of a few bp
 *     plus drift during volatile minutes. If you mix this with the on-chain
 *     feed inside a strategy, calibrate / detrend first.
 *   - Public rate limits: 1200 req/min per IP (very generous given our cache).
 *   - Some regions block `api.binance.com` — override via `BINANCE_BASE_URL`.
 *   - Symbol availability changes; `SUIUSDC` is the v1 default and will 400
 *     if Binance has only `SUIUSDT` listed in your region.
 */

import type { PriceFeed } from "../priceFeed.ts";
import type { PoolProfile } from "../../pools/types.ts";
import type { PriceObservation } from "../../domain/types.ts";
import type { OhlcvBar } from "../../forecast/types.ts";
import { getDb } from "../../db/client.ts";
import { PriceFeedError } from "../../lib/errors.ts";
import { log } from "../../lib/logger.ts";

const DEFAULT_BASE_URL = "https://api.binance.com";
const SPOT_CACHE_TTL_MS = 1_500;
const KLINES_HARD_LIMIT = 1_000;

interface BinanceTickerResponse {
  symbol: string;
  price: string;
}

// Binance kline: 12-element heterogeneous tuple.
//   [openTime, open, high, low, close, volume,
//    closeTime, quoteVolume, trades, takerBuyBase, takerBuyQuote, ignore]
type BinanceKline = [
  number, string, string, string, string, string,
  number, string, number, string, string, string,
];

function intervalToBinance(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "1m";
  if (minutes < 3) return "1m";
  if (minutes < 5) return "3m";
  if (minutes < 15) return "5m";
  if (minutes < 30) return "15m";
  if (minutes < 60) return "30m";
  const hours = Math.round(minutes / 60);
  if (hours < 2) return "1h";
  if (hours < 4) return "2h";
  if (hours < 6) return "4h";
  if (hours < 12) return "6h";
  if (hours < 24) return "12h";
  const days = Math.round(hours / 24);
  if (days < 3) return "1d";
  if (days < 7) return "3d";
  return "1w";
}

export function createBinancePriceFeed(profile: PoolProfile): PriceFeed {
  const symbol = (process.env.BINANCE_SYMBOL?.trim() || "SUIUSDC").toUpperCase();
  const baseUrl = process.env.BINANCE_BASE_URL?.trim() || DEFAULT_BASE_URL;
  const source = `binance:${symbol}`;

  let cachedSpot: PriceObservation | null = null;
  let cacheExpiresAt = 0;

  function persistObservation(obs: PriceObservation): void {
    let db;
    try { db = getDb(); } catch { return; }
    try {
      db.prepare(
        `INSERT INTO price_observations (pool_id, source, price, observed_ms) VALUES (?, ?, ?, ?)`,
      ).run(profile.poolId, obs.source, obs.price, obs.timestampMs);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`${source}: persist failed`, { error: msg });
    }
  }

  async function jsonFetch<T>(url: string): Promise<T> {
    let resp: Response;
    try {
      resp = await fetch(url, {
        headers: { "User-Agent": "LiquidityManager/0.1" },
      });
    } catch (err) {
      throw new PriceFeedError(`${source}: fetch failed (${url})`, err);
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new PriceFeedError(
        `${source}: HTTP ${resp.status} ${resp.statusText} body=${body.slice(0, 200)}`,
      );
    }
    return (await resp.json()) as T;
  }

  async function fetchSpot(): Promise<PriceObservation> {
    const url = `${baseUrl}/api/v3/ticker/price?symbol=${symbol}`;
    const data = await jsonFetch<BinanceTickerResponse>(url);
    if (!data?.price || data.symbol !== symbol) {
      throw new PriceFeedError(
        `${source}: invalid ticker payload ${JSON.stringify(data).slice(0, 200)}`,
      );
    }
    return { price: data.price, timestampMs: Date.now(), source };
  }

  async function fetchKlines(intervalMs: number, windowMs: number): Promise<BinanceKline[]> {
    const interval = intervalToBinance(intervalMs);
    const count = Math.min(
      Math.max(Math.ceil(windowMs / Math.max(intervalMs, 60_000)), 1),
      KLINES_HARD_LIMIT,
    );
    const url = `${baseUrl}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${count}`;
    return jsonFetch<BinanceKline[]>(url);
  }

  return {
    source,

    async getSpot(): Promise<PriceObservation> {
      const now = Date.now();
      if (cachedSpot !== null && now < cacheExpiresAt) return cachedSpot;
      const obs = await fetchSpot();
      cachedSpot = obs;
      cacheExpiresAt = now + SPOT_CACHE_TTL_MS;
      persistObservation(obs);
      return obs;
    },

    async getHistory(windowMs: number): Promise<PriceObservation[]> {
      const bucketMs = 60_000;
      const klines = await fetchKlines(bucketMs, windowMs);
      const out: PriceObservation[] = klines.map((k) => ({
        price: k[4],
        timestampMs: k[6],
        source,
      }));
      for (const obs of out) persistObservation(obs);
      return out;
    },

    async getOhlcv(bucketMs: number, windowMs: number): Promise<OhlcvBar[]> {
      let klines: BinanceKline[];
      try {
        klines = await fetchKlines(bucketMs, windowMs);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`${source}: getOhlcv klines fetch failed`, { error: msg });
        return [];
      }
      return klines.map((k) => ({
        bucketStartMs: k[0],
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
      }));
    },
  };
}
