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
  /** ms since the last successful Binance SUIUSDC update. */
  sui: number;
  /** ms since the last successful Binance BTCUSDT update (same feed as sui). */
  btc: number;
  /** ms since the last successful Binance ETHUSDT update (same feed as sui). */
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

      const snapshot: MarketSnapshot = {
        ts: now(),
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
      const binanceAge = binance.lastUpdatedMs() === 0 ? Infinity : nowMs - binance.lastUpdatedMs();
      const derivAge = derivatives.lastUpdatedMs() === 0 ? Infinity : nowMs - derivatives.lastUpdatedMs();
      const cetusAge = cetus.lastUpdatedMs() === 0 ? Infinity : nowMs - cetus.lastUpdatedMs();

      // binance feed covers all three symbols from the same REST calls,
      // so sui/btc/eth staleness is the same value.
      return {
        sui: binanceAge,
        btc: binanceAge,
        eth: binanceAge,
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
