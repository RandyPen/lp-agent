/**
 * src/data/marketAggregator.ts
 *
 * Multi-source market snapshot aggregator (plan §3.5).
 *
 * Assembles a `MarketSnapshot` from the three feed caches:
 *   - BinanceMultiFeed   — SUI/BTC/ETH OHLCV windows
 *   - DerivativesFeed    — funding rate, open interest, liq1m
 *   - CetusEventsFeed    — active bin, price, TVL, bin step
 *
 * The aggregator computes:
 *   spread = (cetus_price − binance_sui_close) / binance_sui_close
 *
 * Design invariants:
 *   - `latest()` THROWS `DataOutageError` if any essential source has never
 *     been populated (no fallback fabrication — project policy: fail loudly).
 *   - `staleness()` exposes per-source age (ms since last update) so the risk
 *     layer can decide independently whether to use or discard a snapshot.
 *   - `allSourcesDown(maxAgeMs)` returns true when EVERY source exceeds the
 *     age threshold — used by the risk module's data-outage EXTREME trigger.
 */

import type { MarketSnapshot } from "../prediction/types.ts";
import type { BinanceMultiFeed } from "./feeds/binanceMulti.ts";
import type { DerivativesFeed } from "./feeds/derivatives.ts";
import type { CetusEventsFeed } from "./feeds/cetusEvents.ts";
import { LiquidityManagerError } from "../lib/errors.ts";

// ---------------------------------------------------------------------------
// Typed error
// ---------------------------------------------------------------------------

/**
 * Thrown by `MarketAggregator.latest()` when one or more essential feeds have
 * never been populated (lastUpdatedMs() === 0). This prevents silent fabrication
 * of snapshots from zero-valued defaults.
 */
export class DataOutageError extends LiquidityManagerError {
  readonly emptySources: string[];
  constructor(emptySources: string[]) {
    super(
      "data_outage",
      `MarketAggregator: essential sources not yet populated: [${emptySources.join(", ")}]`,
    );
    this.name = "DataOutageError";
    this.emptySources = emptySources;
  }
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface StalenessInfo {
  /**
   * ms since the last successful Binance SUIUSDC 1m update.
   * This is the strategy-critical feed — it drives the feed-level outage guard.
   *
   * Returns `Number.MAX_SAFE_INTEGER` (not `Infinity`) when a feed has never
   * updated (`lastUpdatedMs() === 0`). This sentinel survives `JSON.stringify`
   * (Infinity serializes as null) and is still greater than any reasonable
   * `maxAgeMs` comparison used by `allSourcesDown()`.
   */
  sui: number;
  /**
   * ms since the last successful Binance BTCUSDT 1m update.
   * Derived from symbolLastUpdatedMs when available; falls back to the
   * feed-level lastUpdatedMs (SUI 1m) for feeds that don't expose per-symbol
   * staleness.
   */
  btc: number;
  /**
   * ms since the last successful Binance ETHUSDT 1m update.
   * Same fallback semantics as btc.
   */
  eth: number;
  /** ms since the last successful derivatives update. */
  derivatives: number;
  /** ms since the last successful Cetus pool state update. */
  cetus: number;
}

export interface MarketAggregator {
  /** Start all underlying feeds. Returns a composite stop function. */
  start(): () => void;
  /**
   * Assemble and return the latest MarketSnapshot from feed caches.
   * THROWS `DataOutageError` if any essential source has never been populated.
   */
  latest(): MarketSnapshot;
  /** Per-source staleness in ms (how long ago each feed last updated). */
  staleness(): StalenessInfo;
  /**
   * Returns true when ALL sources have not been updated within `maxAgeMs`.
   * This is the risk module's data-outage signal (§5.3: all sources gone → EXTREME).
   */
  allSourcesDown(maxAgeMs: number): boolean;
}

// ---------------------------------------------------------------------------
// Dependencies type
// ---------------------------------------------------------------------------

export interface MarketAggregatorDeps {
  binance: BinanceMultiFeed;
  derivatives: DerivativesFeed;
  cetus: CetusEventsFeed;
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMarketAggregator(deps: MarketAggregatorDeps): MarketAggregator {
  const { binance, derivatives, cetus } = deps;
  const now = deps.now ?? (() => Date.now());

  return {
    start(): () => void {
      const stopBinance = binance.start();
      const stopDerivatives = derivatives.start();
      const stopCetus = cetus.start();
      return () => {
        stopBinance();
        stopDerivatives();
        stopCetus();
      };
    },

    latest(): MarketSnapshot {
      // Guard: all essential sources must have been populated at least once.
      const empty: string[] = [];
      if (binance.lastUpdatedMs() === 0) empty.push("binance");
      if (derivatives.lastUpdatedMs() === 0) empty.push("derivatives");
      if (cetus.lastUpdatedMs() === 0) empty.push("cetus");

      if (empty.length > 0) {
        throw new DataOutageError(empty);
      }

      const binanceData = binance.latest();
      const derivData = derivatives.latest();
      const cetusData = cetus.latest();

      // Compute cross-market spread.
      // Use the close price of the most-recent SUI bar as the Binance reference.
      // If there are no SUI bars (feed just started), spread = 0 and we still
      // throw above if binance.lastUpdatedMs() === 0, so this is only reached
      // when there is real data.
      const suiBars = binanceData.sui;
      let latestSuiClose = 0;
      if (suiBars.length > 0) {
        const lastBar = suiBars[suiBars.length - 1];
        if (lastBar !== undefined) latestSuiClose = lastBar.close;
      }
      const cetusPrice = Number(cetusData.price);

      let spread = 0;
      if (latestSuiClose > 0 && cetusPrice > 0) {
        spread = (cetusPrice - latestSuiClose) / latestSuiClose;
      }

      // snapshot.ts is the newest underlying data timestamp — max of the
      // feeds' lastUpdatedMs values that contributed to this snapshot.
      // Using wall-clock here would make downstream staleness checks measure
      // "how recently latest() was called" rather than data age; max-of-sources
      // correctly reflects when the data was last refreshed.
      const dataTs = Math.max(
        binance.lastUpdatedMs(),
        derivatives.lastUpdatedMs(),
        cetus.lastUpdatedMs(),
      );

      const snapshot: MarketSnapshot = {
        ts: dataTs,
        cetus: {
          activeBin: cetusData.activeBin,
          price: cetusData.price,
          tvlUsd: cetusData.tvlUsd,
          binStep: cetusData.binStep,
        },
        binance: {
          sui: binanceData.sui,
          btc: binanceData.btc,
          eth: binanceData.eth,
        },
        derivatives: {
          funding: derivData.funding,
          oi: derivData.oi,
          liq1m: derivData.liq1m,
        },
        spread,
      };

      return snapshot;
    },

    staleness(): StalenessInfo {
      const nowMs = now();

      // Use per-symbol staleness when the feed exposes symbolLastUpdatedMs
      // (the per-symbol tracking introduced in F2). Fall back to the feed-level
      // SUI 1m timestamp for feeds that don't implement the extended surface.
      //
      // When a feed has never updated (lastMs === 0), return the sentinel value
      // Number.MAX_SAFE_INTEGER rather than Infinity so that staleness objects
      // survive JSON.stringify() without becoming null.
      const NEVER_UPDATED_SENTINEL = Number.MAX_SAFE_INTEGER;
      function ageMs(lastMs: number): number {
        return lastMs === 0 ? NEVER_UPDATED_SENTINEL : nowMs - lastMs;
      }

      const hasSym = "symbolLastUpdatedMs" in binance &&
        typeof (binance as { symbolLastUpdatedMs: unknown }).symbolLastUpdatedMs === "function";

      const suiAge = ageMs(binance.lastUpdatedMs()); // always SUI 1m
      const btcAge = hasSym
        ? ageMs((binance as { symbolLastUpdatedMs(s: string, i: "1m" | "5m"): number })
            .symbolLastUpdatedMs("BTCUSDT", "1m"))
        : suiAge;
      const ethAge = hasSym
        ? ageMs((binance as { symbolLastUpdatedMs(s: string, i: "1m" | "5m"): number })
            .symbolLastUpdatedMs("ETHUSDT", "1m"))
        : suiAge;

      const derivAge = ageMs(derivatives.lastUpdatedMs());
      const cetusAge = ageMs(cetus.lastUpdatedMs());

      return {
        sui: suiAge,
        btc: btcAge,
        eth: ethAge,
        derivatives: derivAge,
        cetus: cetusAge,
      };
    },

    allSourcesDown(maxAgeMs: number): boolean {
      const s = this.staleness();
      return (
        s.sui > maxAgeMs &&
        s.derivatives > maxAgeMs &&
        s.cetus > maxAgeMs
      );
    },
  };
}
