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
 *
 * Staleness contract (F2 fix):
 *   - Per-symbol, per-interval `lastUpdatedMs` are tracked independently.
 *   - The feed-level `lastUpdatedMs()` reflects only the SUI 1m window — the
 *     strategy-critical input used by marketAggregator's outage guard.
 *   - `symbolLastUpdatedMs(symbol, interval)` surfaces per-symbol staleness for
 *     diagnostics and the `staleness()` surface in marketAggregator.
 *   - When SUI 1m batch fails but BTC/ETH succeed, a WARN is emitted and the
 *     feed-level timestamp is NOT updated (preventing silent stale SUI data).
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
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
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
  /**
   * Epoch ms of the last successful SUI 1m update, or 0 if never updated.
   *
   * Strategy-critical: this value is what marketAggregator's outage guard
   * checks. It reflects only the SUI 1m window because that is the primary
   * feature source for DLMM position decisions.
   */
  lastUpdatedMs(): number;
  /**
   * Per-symbol, per-interval last-updated timestamps for diagnostics.
   *
   * Returns 0 for a symbol/interval that has never successfully updated.
   * Keys use the form `"SUIUSDC:1m"`, `"BTCUSDT:5m"`, etc.
   */
  symbolLastUpdatedMs(symbol: string, interval: "1m" | "5m"): number;
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

// The SUI 1m symbol key used for the feed-level staleness signal.
const SUI_SYMBOL = "SUIUSDC";

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
  const nowFn = opts.now ?? (() => Date.now());

  // In-memory rolling windows per symbol per interval.
  const windows1m: BinanceMultiWindows = { sui: [], btc: [], eth: [] };
  const windows5m: BinanceMultiWindows = { sui: [], btc: [], eth: [] };

  // Per-symbol, per-interval last-updated timestamps.
  // Key format: "<SYMBOL>:<interval>" e.g. "SUIUSDC:1m", "BTCUSDT:5m".
  const symbolUpdated = new Map<string, number>();

  function symKey(symbol: string, interval: "1m" | "5m"): string {
    return `${symbol}:${interval}`;
  }

  function markSymbolUpdated(symbol: string, interval: "1m" | "5m"): void {
    symbolUpdated.set(symKey(symbol, interval), nowFn());
  }

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

  /**
   * Refresh all symbols for a given interval. Per-symbol results are settled
   * independently so a BTC failure doesn't block SUI from updating.
   *
   * Feed-level lastUpdatedMs (used by marketAggregator's outage guard) is only
   * updated when the SUI 1m batch succeeds. When SUI fails but others succeed,
   * a WARN is emitted so operators know the strategy-critical feed is stale.
   */
  async function refreshAllForInterval(interval: "1m" | "5m", maxBars: number): Promise<void> {
    const results = await Promise.allSettled(
      SYMBOLS.map((cfg) =>
        refreshSymbol(cfg, interval, maxBars).then((bars) => {
          const windows = interval === "1m" ? windows1m : windows5m;
          windows[cfg.key] = mergeWindow(windows[cfg.key], bars, maxBars);
          markSymbolUpdated(cfg.symbol, interval);
        }),
      ),
    );

    // Log per-symbol failures.
    const failures = results
      .map((r, i) => ({ result: r, cfg: SYMBOLS[i]! }))
      .filter((x) => x.result.status === "rejected");

    if (failures.length > 0) {
      for (const { result, cfg } of failures) {
        log.warn("binanceMulti: partial refresh failure", {
          symbol: cfg.symbol,
          interval,
          error: (result as PromiseRejectedResult).reason instanceof Error
            ? (result as PromiseRejectedResult).reason.message
            : String((result as PromiseRejectedResult).reason),
        });
      }

      // Warn specifically when the SUI 1m batch failed (strategy-critical).
      if (interval === "1m") {
        const suiFailed = failures.some((x) => x.cfg.symbol === SUI_SYMBOL);
        const othersSucceeded = failures.length < SYMBOLS.length;
        if (suiFailed && othersSucceeded) {
          log.warn("binanceMulti: SUI 1m batch failed while other symbols succeeded — " +
            "feed-level lastUpdatedMs will NOT advance; snapshots may have stale SUI bars", {
            successfulSymbols: SYMBOLS
              .filter((s) => results[SYMBOLS.indexOf(s)]!.status === "fulfilled")
              .map((s) => s.symbol),
          });
        }
      }
    }
  }

  /**
   * Initial full refresh (both intervals, all symbols).
   * Errors are logged but do not throw so the agent loop can continue.
   */
  async function refreshAll(): Promise<void> {
    await Promise.allSettled([
      refreshAllForInterval("1m", maxBars1m),
      refreshAllForInterval("5m", maxBars5m),
    ]);
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
        refreshAllForInterval("1m", maxBars1m).catch((err: unknown) => {
          log.warn("binanceMulti: 1m interval refresh loop error", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }, REFRESH_1M_INTERVAL_MS);

      const timer5m = setInterval(() => {
        refreshAllForInterval("5m", maxBars5m).catch((err: unknown) => {
          log.warn("binanceMulti: 5m interval refresh loop error", {
            error: err instanceof Error ? err.message : String(err),
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

    /**
     * Returns the last-updated timestamp for the SUI 1m window.
     *
     * This is the feed-level staleness signal consumed by marketAggregator's
     * outage guard. It only advances when the SUI 1m batch succeeds, so a
     * partial success (BTC/ETH ok, SUI failed) correctly keeps this at its
     * previous value and triggers the outage guard when the window expires.
     */
    lastUpdatedMs(): number {
      return symbolUpdated.get(symKey(SUI_SYMBOL, "1m")) ?? 0;
    },

    symbolLastUpdatedMs(symbol: string, interval: "1m" | "5m"): number {
      return symbolUpdated.get(symKey(symbol, interval)) ?? 0;
    },
  };
}
