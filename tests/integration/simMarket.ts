/**
 * tests/integration/simMarket.ts
 *
 * Synthetic market generator for integration tests.
 *
 * Produces deterministic OhlcvBar streams and pool state for a SUI/USDC pool.
 * Uses a seeded LCG for reproducibility — never uses Math.random() directly.
 *
 * Pool: binStep=10, price≈3.50, activeBin≈8500
 * Bars: 1-minute intervals
 *
 * Scenarios:
 *   "calm":    σ_1m≈0.1%, flat price≈3.50, TVL≈$1M, spread≈0%
 *   "trend":   +0.05%/bar sustained drift (bullish)
 *   "crash":   -12% price drop over 5 bars then stabilize, TVL -60%
 *   "recover": stabilize + drift back toward original price
 *   "step":    +1.5% jump on first bar then calm
 */

import type { MarketSnapshot, OhlcvBar } from "../../src/prediction/types.ts";

// ---------------------------------------------------------------------------
// Seeded LCG (Linear Congruential Generator)
// Returns values in [0, 1)
// ---------------------------------------------------------------------------

export function lcg(seed: number): () => number {
  // Park-Miller parameters
  const a = 1664525;
  const c = 1013904223;
  const m = 2 ** 32;
  let state = seed >>> 0;
  return function () {
    state = ((a * state + c) >>> 0);
    return state / m;
  };
}

// ---------------------------------------------------------------------------
// Pool constants
// ---------------------------------------------------------------------------

export const POOL_ID = "0xsim_pool";
export const BIN_STEP = 10;
export const BASE_PRICE = 3.50;
export const BASE_ACTIVE_BIN = 8500;

/**
 * Relative price change per bin step: binStep / 10_000
 * USDC_PER_BIN_STEP = 0.001 (0.1% per bin step)
 */
export const USDC_PER_BIN_STEP = BIN_STEP / 10_000;

/**
 * Compute the active bin that corresponds to a given price.
 * Uses the geometric DLMM formula: price = BASE_PRICE * (1 + binStep/10_000)^(bin - BASE_ACTIVE_BIN)
 * Solving for bin: bin = BASE_ACTIVE_BIN + log(price / BASE_PRICE) / log(1 + binStep/10_000)
 */
export function activeBinFromPrice(price: number): number {
  return Math.round(
    BASE_ACTIVE_BIN + Math.log(price / BASE_PRICE) / Math.log(1 + BIN_STEP / 10_000),
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SimScenario = "calm" | "trend" | "crash" | "recover" | "step";

export interface SimBar extends OhlcvBar {
  scenario: SimScenario;
  price: number;      // close price (same as close, convenience alias)
  tvlUsd: number;
  activeBin: number;
}

export interface GenerateScenarioParams {
  scenario: SimScenario;
  bars: number;
  startTs: number;
  startPrice?: number;
  startTvlUsd?: number;
  seed?: number;
}

// ---------------------------------------------------------------------------
// Main generator
// ---------------------------------------------------------------------------

export function generateScenario(params: GenerateScenarioParams): SimBar[] {
  const {
    scenario,
    bars,
    startTs,
    startPrice = BASE_PRICE,
    startTvlUsd = 1_000_000,
    seed = 42,
  } = params;

  const rand = lcg(seed);
  const result: SimBar[] = [];

  let prevClose = startPrice;
  let prevTvl = startTvlUsd;
  const BAR_MS = 60_000; // 1 minute per bar

  for (let i = 0; i < bars; i++) {
    const ts = startTs + i * BAR_MS;
    let close: number;
    let tvl: number;

    switch (scenario) {
      case "calm": {
        // σ_1m ≈ 0.1%: noise scaled to 0.001
        const noise = (rand() - 0.5) * 2 * 0.001;
        close = prevClose * (1 + noise);
        tvl = prevTvl; // constant
        break;
      }
      case "trend": {
        // +0.05%/bar drift with small noise
        const noise = (rand() - 0.5) * 2 * 0.0001;
        close = prevClose * (1 + 0.0005 + noise);
        tvl = prevTvl;
        break;
      }
      case "crash": {
        if (i < 5) {
          // -2.4% per bar for 5 bars = -12% total
          const noise = (rand() - 0.5) * 2 * 0.0002;
          close = prevClose * (1 - 0.024 + noise);
          // TVL drops proportional to price
          const fraction = i / 5;
          tvl = startTvlUsd * (1 - 0.60 * fraction);
        } else {
          // Stabilize after crash
          const noise = (rand() - 0.5) * 2 * 0.001;
          close = prevClose * (1 + noise);
          tvl = startTvlUsd * 0.40; // settled at 40% of original
        }
        break;
      }
      case "recover": {
        // +0.03%/bar drift back up from crash low
        const noise = (rand() - 0.5) * 2 * 0.0005;
        close = prevClose * (1 + 0.0003 + noise);
        // TVL recovers slowly: +0.2% per bar
        tvl = Math.min(prevTvl * 1.002, startTvlUsd);
        break;
      }
      case "step": {
        if (i === 0) {
          // +1.5% jump on first bar
          close = prevClose * 1.015;
        } else {
          // Calm after
          const noise = (rand() - 0.5) * 2 * 0.001;
          close = prevClose * (1 + noise);
        }
        tvl = prevTvl;
        break;
      }
    }

    // Ensure close is positive
    close = Math.max(close, 0.001);

    // Construct OHLC: vary by ±noise/2 around close for realism
    const intrabarNoise = (rand() * 0.0005);
    const open = prevClose;
    const high = Math.max(open, close) * (1 + intrabarNoise);
    const low = Math.min(open, close) * (1 - intrabarNoise);
    const volume = 50_000 + rand() * 50_000;

    const bin = activeBinFromPrice(close);

    result.push({
      ts,
      open,
      high,
      low,
      close,
      volume,
      scenario,
      price: close,
      tvlUsd: tvl,
      activeBin: bin,
    });

    prevClose = close;
    prevTvl = tvl;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Snapshot builder
// ---------------------------------------------------------------------------

/**
 * Build a MarketSnapshot from a SimBar and the window of recent bars.
 * The window should be the last 120 bars (or however many are available).
 * BTC and ETH bars are set to the SUI bars (simplified).
 */
export function barToSnapshot(
  bar: SimBar,
  windowBars: OhlcvBar[],
  ts?: number,
): MarketSnapshot {
  const snapshotTs = ts ?? bar.ts;

  // Slice window to max 120 bars, oldest-first
  const window120 = windowBars.slice(-120);

  return {
    ts: snapshotTs,
    cetus: {
      activeBin: bar.activeBin,
      price: bar.price.toFixed(10),
      tvlUsd: bar.tvlUsd,
      binStep: BIN_STEP,
    },
    binance: {
      sui: window120,
      btc: window120,
      eth: window120,
    },
    derivatives: {
      funding: 0.0001,
      oi: 1_000_000,
      liq1m: 0,
    },
    spread: 0, // zero spread for simplicity in tests
  };
}
