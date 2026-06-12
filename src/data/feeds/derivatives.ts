/**
 * src/data/feeds/derivatives.ts
 *
 * Binance futures derivatives feed: funding rate, open interest, and
 * 1-minute liquidation volume for SUI perpetual contracts.
 *
 * Endpoints used:
 *   - Funding rate: GET https://fapi.binance.com/fapi/v1/premiumIndex?symbol=SUIUSDT
 *   - Open interest: GET https://fapi.binance.com/fapi/v1/openInterest?symbol=SUIUSDT
 *
 * Liquidation (liq1m):
 *   The Binance REST liquidation history endpoint (`/fapi/v1/forceOrders`) only
 *   returns the last order and requires API auth for full history. The WebSocket
 *   stream `wss://fstream.binance.com/ws/!forceOrder@arr` provides live events but
 *   maintaining a reliable rolling 1-minute accumulator over a stateful WS is
 *   non-trivial for v1. Per data-sources.md §3.3 guidance, the REST approach for
 *   liquidation history is insufficient. We return 0 for liq1m in this v1
 *   implementation with a structured log on start, leaving the WebSocket capture
 *   as a documented TODO for v1.1.
 *
 *   TODO(v1.1): Subscribe to wss://fstream.binance.com/ws/!forceOrder@arr and
 *   accumulate USD-notional liquidation volume into a 1-minute rolling sum. This
 *   requires maintaining a WS connection with heartbeat/reconnect logic similar
 *   to binanceMulti.ts's timer model.
 *
 * Retry/backoff mirrors the pattern from binance.ts.
 */

import { log } from "../../lib/logger.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_FAPI_BASE_URL = "https://fapi.binance.com";
const DEFAULT_SYMBOL = "SUIUSDT";

// Polling intervals per data-sources.md §9.3.
const FUNDING_POLL_INTERVAL_MS = 60_000;    // 1 minute
const OI_POLL_INTERVAL_MS = 5 * 60_000;    // 5 minutes

// Retry policy.
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface BinancePremiumIndex {
  symbol: string;
  lastFundingRate: string;
  nextFundingTime: number;
  time: number;
}

interface BinanceOpenInterest {
  symbol: string;
  openInterest: string;
  time: number;
}

export interface DerivativesSnapshot {
  /** Latest funding rate (fractional, e.g. 0.0001 = 1 bp per 8h). */
  funding: number;
  /** Open interest in USD. */
  oi: number;
  /**
   * 1-minute liquidation USD volume.
   * Always 0 in v1 — see file-level TODO.
   */
  liq1m: number;
}

/** Minimal fetch-compatible function type for injecting in tests. */
export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface DerivativesFeedOptions {
  /** Binance Futures REST base URL. Defaults to https://fapi.binance.com */
  fapiBaseUrl?: string;
  /** Perpetual contract symbol. Defaults to SUIUSDT. */
  symbol?: string;
  /** Injectable fetch function for testing. Defaults to global fetch. */
  fetchFn?: FetchFn;
}

export interface DerivativesFeed {
  /** Start background polling loop. Returns a stop function. */
  start(): () => void;
  /** Latest cached snapshot. */
  latest(): DerivativesSnapshot;
  /** Epoch ms of the last successful update, or 0 if never updated. */
  lastUpdatedMs(): number;
}

// ---------------------------------------------------------------------------
// Helpers
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

export function createDerivativesFeed(opts: DerivativesFeedOptions = {}): DerivativesFeed {
  const fapiBaseUrl = opts.fapiBaseUrl ?? (process.env.BINANCE_FAPI_BASE_URL?.trim() || DEFAULT_FAPI_BASE_URL);
  const symbol = (opts.symbol ?? (process.env.BINANCE_PERP_SYMBOL?.trim() || DEFAULT_SYMBOL)).toUpperCase();
  const fetchFn: FetchFn = opts.fetchFn ?? fetch;

  // Cached snapshot.
  let cachedFunding = 0;
  let cachedOi = 0;
  let lastUpdated = 0;

  async function jsonFetch<T>(url: string): Promise<T> {
    let resp: Response;
    try {
      resp = await fetchFn(url, {
        headers: { "User-Agent": "LiquidityManager/0.1" },
      });
    } catch (err) {
      throw new Error(`derivatives: fetch failed (${url}): ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`derivatives: HTTP ${resp.status} ${resp.statusText} body=${body.slice(0, 200)}`);
    }
    return (await resp.json()) as T;
  }

  async function refreshFunding(): Promise<void> {
    const url = `${fapiBaseUrl}/fapi/v1/premiumIndex?symbol=${symbol}`;
    const data = await withRetry(
      `derivatives:funding:${symbol}`,
      () => jsonFetch<BinancePremiumIndex>(url),
      MAX_RETRIES,
    );
    cachedFunding = Number(data.lastFundingRate);
    lastUpdated = Date.now();
  }

  async function refreshOi(): Promise<void> {
    const url = `${fapiBaseUrl}/fapi/v1/openInterest?symbol=${symbol}`;
    const data = await withRetry(
      `derivatives:oi:${symbol}`,
      () => jsonFetch<BinanceOpenInterest>(url),
      MAX_RETRIES,
    );
    cachedOi = Number(data.openInterest);
    lastUpdated = Date.now();
  }

  async function refreshAll(): Promise<void> {
    await Promise.all([refreshFunding(), refreshOi()]);
  }

  return {
    start(): () => void {
      // Log the liq1m limitation once on startup so it's visible in production
      // logs without being noisy on every poll cycle.
      log.info("derivatives: liq1m is always 0 in v1 (WS liquidation capture not yet implemented)", {
        todo: "Subscribe to wss://fstream.binance.com/ws/!forceOrder@arr in v1.1",
      });

      // Initial load — errors are logged, not thrown.
      refreshAll().catch((err: unknown) => {
        log.error("derivatives: initial refresh failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });

      const fundingTimer = setInterval(() => {
        refreshFunding().catch((err: unknown) => {
          log.warn("derivatives: funding poll failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }, FUNDING_POLL_INTERVAL_MS);

      const oiTimer = setInterval(() => {
        refreshOi().catch((err: unknown) => {
          log.warn("derivatives: OI poll failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }, OI_POLL_INTERVAL_MS);

      return () => {
        clearInterval(fundingTimer);
        clearInterval(oiTimer);
      };
    },

    latest(): DerivativesSnapshot {
      return {
        funding: cachedFunding,
        oi: cachedOi,
        liq1m: 0,
      };
    },

    lastUpdatedMs(): number {
      return lastUpdated;
    },
  };
}
