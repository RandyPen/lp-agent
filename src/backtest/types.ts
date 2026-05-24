/**
 * Types for the v0 backtest harness. The harness replays persisted price
 * observations through a strategy and records each tick's decision. Full
 * fee / IL / gas accounting lands in Phase 2.5; for now the harness just
 * surfaces the strategy's behavior on historical data so the operator can
 * sanity-check trigger frequency and bin selection.
 */

import type { PMState, PoolState, PriceObservation } from "../domain/types.ts";
import type { PoolProfile } from "../pools/types.ts";
import type { StrategyOutput } from "../strategies/types.ts";

export interface BacktestInput {
  profile: PoolProfile;
  strategyName: string;
  /** Oldest-first; one PriceObservation per simulated tick. */
  observations: PriceObservation[];
  /** Initial PM balance (raw atomic). */
  initialBalanceA: bigint;
  initialBalanceB: bigint;
  /** History window the strategy sees on each tick (ms). */
  historyWindowMs: number;
}

export interface TickRecord {
  index: number;
  timestampMs: number;
  spotPrice: string;
  activeBinId: number;
  pmBalance: { a: string; b: string };
  pmPositionBins: number[];
  output: StrategyOutput;
}

export interface BacktestResult {
  ticks: TickRecord[];
  summary: BacktestSummary;
}

export interface BacktestSummary {
  totalTicks: number;
  byKind: Record<StrategyOutput["kind"], number>;
  uniqueBinsTouched: number;
  firstTimestampMs: number;
  lastTimestampMs: number;
  windowDays: number;
  strategyName: string;
  poolName: string;
}

/**
 * Simulated pool/PM state the harness threads from tick to tick. Exposed for
 * tests so they can drive a single tick deterministically.
 */
export interface SimState {
  pm: PMState;
  pool: PoolState;
}
