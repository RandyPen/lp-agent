/**
 * src/data/feeds/binanceMulti.ts
 *
 * Binance public REST klines for SUIUSDC, BTCUSDT, and ETHUSDT — 1m and 5m
 * intervals — maintained as in-memory rolling windows with periodic refresh.
 *
 * Design notes:
 *   - Reuses the retry/backoff/timeout patterns from binance.ts.
 *   - Default window sizes: 120 bars of 1m (2h) and 288 bars of 5m (24h).
 *   - Each symbol maintains two independent windows (1m and 5m).
 *   - `start()` kicks off a background refresh loop and returns a stop function.
 *   - No SQLite persistence here — the aggregator layer handles any needed
 *     persistence via price_observations.
 *   - Fetch function is injectable for deterministic tests.
 */

import { log } from "../../lib/logger.ts";
import type { OhlcvBar } from "../../prediction/types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "https://api.binance.com";

// Default rolling window lengths (bar count).
const DEFAULT_1M_BARS = 120;   // 2 hours of 1-minute bars
const DEFAULT_5M_BARS = 288;   // 24 hours of 5-minute bars

// Klines hard limit per Binance REST API page.
const KLINES_PAGE_LIMIT = 500;

// Retry policy.
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;

// Refresh intervals.
const REFRESH_1M_INTERVAL_MS = 60_000;   // refresh 1m window every minute
const REFRESH_5M_INTERVAL_MS = 5 * 60_000; // refresh 5m window every 5 minutes

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

// Binance kline tuple: [openTime, open, high, low, close, volume, closeTime, ...]
type BinanceKline = [
  number, string, string, string, string, string,
  number, string, number, string, string, string,
];

/** Minimal fetch-compatible function type for injecting in tests. */
export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface BinanceMultiFeedOptions {
  /** Binance REST base URL. Defaults to https://api.binance.com */
  baseUrl?: string;
  /** Number of 1-minute bars to keep per symbol. Default 120 (2h). */
  bars1m?: number;
  /** Number of 5-minute bars to keep per symbol. Default 288 (24h). */
  bars5m?: number;
  /** Injectable fetch function (for testing). Defaults to global fetch. */
  fetchFn?: FetchFn;
}

export interface BinanceMultiWindows {
  sui: OhlcvBar[];
  btc: OhlcvBar[];
  eth: OhlcvBar[];
}

export interface BinanceMultiFeed {
  /** Start background refresh loop. Returns a stop function. */
  start(): () => void;
  /** Latest in-memory rolling windows (oldest-first). */
  latest1m(): BinanceMultiWindows;
  latest5m(): BinanceMultiWindows;
  /** Combined latest windows for MarketSnapshot (uses 1m bars). */
  latest(): BinanceMultiWindows;
  /** Epoch ms of the last successful update, or 0 if never updated. */
  lastUpdatedMs(): number;
}

// ---------------------------------------------------------------------------
// Symbol config
// ---------------------------------------------------------------------------

interface SymbolConfig {
  symbol: string;
  key: keyof BinanceMultiWindows;
}

const SYMBOLS: SymbolConfig[] = [
  { symbol: "SUIUSDC", key: "sui" },
  { symbol: "BTCUSDT", key: "btc" },
  { symbol: "ETHUSDT", key: "eth" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function klinesUrl(
  baseUrl: string,
  symbol: string,
  interval: "1m" | "5m",
  limit: number,
): string {
  return `${baseUrl}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
}

function parseKlines(klines: BinanceKline[]): OhlcvBar[] {
  return klines.map((k) => ({
    ts: k[0],
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
  }));
}

/**
 * Merge incoming bars into the existing window, deduplicating by ts and
 * keeping only the most-recent `maxBars` entries.
 */
function mergeWindow(existing: OhlcvBar[], incoming: OhlcvBar[], maxBars: number): OhlcvBar[] {
  if (incoming.length === 0) return existing;

  // Build a map keyed by ts so incoming bars overwrite stale entries.
  const map = new Map<number, OhlcvBar>();
  for (const bar of existing) map.set(bar.ts, bar);
  for (const bar of incoming) map.set(bar.ts, bar);

  // Sort ascending by ts and trim to maxBars.
  const sorted = Array.from(map.values()).sort((a, b) => a.ts - b.ts);
  return sorted.length <= maxBars ? sorted : sorted.slice(sorted.length - maxBars);
}

// ---------------------------------------------------------------------------
// Retry helper (mirrors binance.ts pattern)
// ---------------------------------------------------------------------------

async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  maxRetries: number,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        const delay = Math.min(BASE_RETRY_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS);
        log.warn(`${label}: attempt ${attempt + 1} failed, retrying in ${delay}ms`, {
          error: err instanceof Error ? err.message : String(err),
        });
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createBinanceMultiFeed(opts: BinanceMultiFeedOptions = {}): BinanceMultiFeed {
  const baseUrl = opts.baseUrl ?? (process.env.BINANCE_BASE_URL?.trim() || DEFAULT_BASE_URL);
  const maxBars1m = opts.bars1m ?? DEFAULT_1M_BARS;
  const maxBars5m = opts.bars5m ?? DEFAULT_5M_BARS;
  const fetchFn: FetchFn = opts.fetchFn ?? fetch;

  // In-memory rolling windows per symbol per interval.
  const windows1m: BinanceMultiWindows = { sui: [], btc: [], eth: [] };
  const windows5m: BinanceMultiWindows = { sui: [], btc: [], eth: [] };
  let lastUpdated = 0;

  async function jsonFetch<T>(url: string): Promise<T> {
    let resp: Response;
    try {
      resp = await fetchFn(url, {
        headers: { "User-Agent": "LiquidityManager/0.1" },
      });
    } catch (err) {
      throw new Error(`binanceMulti: fetch failed (${url}): ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`binanceMulti: HTTP ${resp.status} ${resp.statusText} body=${body.slice(0, 200)}`);
    }
    return (await resp.json()) as T;
  }

  async function refreshSymbol(
    cfg: SymbolConfig,
    interval: "1m" | "5m",
    maxBars: number,
  ): Promise<OhlcvBar[]> {
    const limit = Math.min(maxBars, KLINES_PAGE_LIMIT);
    const url = klinesUrl(baseUrl, cfg.symbol, interval, limit);
    const raw = await withRetry(
      `binanceMulti:${cfg.symbol}:${interval}`,
      () => jsonFetch<BinanceKline[]>(url),
      MAX_RETRIES,
    );
    return parseKlines(raw);
  }

  async function refreshAll(): Promise<void> {
    const results = await Promise.allSettled(
      SYMBOLS.flatMap((cfg) => [
        refreshSymbol(cfg, "1m", maxBars1m).then((bars) => {
          windows1m[cfg.key] = mergeWindow(windows1m[cfg.key], bars, maxBars1m);
        }),
        refreshSymbol(cfg, "5m", maxBars5m).then((bars) => {
          windows5m[cfg.key] = mergeWindow(windows5m[cfg.key], bars, maxBars5m);
        }),
      ]),
    );

    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length > 0) {
      for (const f of failures) {
        log.warn("binanceMulti: partial refresh failure", {
          error: (f as PromiseRejectedResult).reason instanceof Error
            ? (f as PromiseRejectedResult).reason.message
            : String((f as PromiseRejectedResult).reason),
        });
      }
    }

    // Update lastUpdated even on partial success (at least some windows refreshed).
    if (failures.length < results.length) {
      lastUpdated = Date.now();
    }
  }

  return {
    start(): () => void {
      // Initial load — errors are logged but do not throw so the agent loop
      // can continue and retry on the next cycle.
      refreshAll().catch((err: unknown) => {
        log.error("binanceMulti: initial refresh failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });

      // Stagger the two timers slightly so they don't race.
      const timer1m = setInterval(() => {
        SYMBOLS.forEach((cfg) => {
          refreshSymbol(cfg, "1m", maxBars1m)
            .then((bars) => {
              windows1m[cfg.key] = mergeWindow(windows1m[cfg.key], bars, maxBars1m);
              lastUpdated = Date.now();
            })
            .catch((err: unknown) => {
              log.warn(`binanceMulti: 1m refresh failed for ${cfg.symbol}`, {
                error: err instanceof Error ? err.message : String(err),
              });
            });
        });
      }, REFRESH_1M_INTERVAL_MS);

      const timer5m = setInterval(() => {
        SYMBOLS.forEach((cfg) => {
          refreshSymbol(cfg, "5m", maxBars5m)
            .then((bars) => {
              windows5m[cfg.key] = mergeWindow(windows5m[cfg.key], bars, maxBars5m);
              lastUpdated = Date.now();
            })
            .catch((err: unknown) => {
              log.warn(`binanceMulti: 5m refresh failed for ${cfg.symbol}`, {
                error: err instanceof Error ? err.message : String(err),
              });
            });
        });
      }, REFRESH_5M_INTERVAL_MS);

      return () => {
        clearInterval(timer1m);
        clearInterval(timer5m);
      };
    },

    latest1m(): BinanceMultiWindows {
      return {
        sui: windows1m.sui.slice(),
        btc: windows1m.btc.slice(),
        eth: windows1m.eth.slice(),
      };
    },

    latest5m(): BinanceMultiWindows {
      return {
        sui: windows5m.sui.slice(),
        btc: windows5m.btc.slice(),
        eth: windows5m.eth.slice(),
      };
    },

    // `latest()` returns 1m bars — the primary snapshot feed consumed by
    // MarketAggregator and ML features.
    latest(): BinanceMultiWindows {
      return {
        sui: windows1m.sui.slice(),
        btc: windows1m.btc.slice(),
        eth: windows1m.eth.slice(),
      };
    },

    lastUpdatedMs(): number {
      return lastUpdated;
    },
  };
}
