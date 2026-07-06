/**
 * Shared domain types. These are the seams between the on-chain layer (sui/),
 * the data layer (data/), the strategy layer (strategies/), and the orchestration
 * layer (services/). All bigints are kept as bigints; all on-chain string ids
 * (object ids, type tags) are kept as strings.
 */

import type { LendingState } from "../sui/lending/types.ts";

/** Snapshot of one PositionManager + its current pool state, ready for strategies to consume. */
export interface PMState {
  pmId: string;
  owner: string;
  poolId: string;
  coinTypeA: string;
  coinTypeB: string;
  /** Balances in the PM's `balance` Bag, keyed by coin type. */
  balance: { a: bigint; b: bigint };
  /** Accumulated, uncollected fees in the PM's `fee` Bag. */
  feeBag: { a: bigint; b: bigint };
  /** Current position bins; empty if no position is open yet. */
  positionBins: PositionBin[];
  /** Current lending positions held by this PM (per protocol, per coin type). */
  lending: LendingState;
  /**
   * Aggregate value locked in `positionBins`, estimated by the EXECUTION
   * layer via a remove-all dryRun (per-bin amounts are 0n in v0 chain reads,
   * so this is the only reliable estimate). A safety haircut is already
   * applied. Set only during the rebalancer's re-planning pass — strategies
   * treat `positionValue` as additional deployable capital when their plan
   * removes the whole position. undefined = unknown (plan from balance+fees
   * only, as before).
   */
  positionValue?: { a: bigint; b: bigint };
}

export interface PositionBin {
  binId: number;
  liquidityShare: bigint;
  amountA: bigint;
  amountB: bigint;
}

export interface PoolState {
  poolId: string;
  activeBinId: number;
  binStep: number;
  /** Total fee rate in basis points (variable + base), best-effort snapshot. */
  feeRateBps: number;
}

export interface PriceObservation {
  /** Quote price in coinB-per-coinA (human-readable, decimal-adjusted). */
  price: string;
  timestampMs: number;
  source: string;
}

/**
 * What a Strategy returns. The rebalancer turns this into one or more on-chain transactions.
 * `removeShares` is applied first (drain old position), then `add` (place new position).
 *
 * Amount-sizing contract: strategies size `addAmounts*` from the PRE-remove
 * snapshot (`pm.balance` + fee bag when `collectFees`). The EXECUTION layer
 * (rebalancer) owns realized-balance sizing — it re-scales the per-bin
 * amounts to the actual post-remove balances via
 * `decision/planMath.rescalePlanToAvailable` before submitting, so the value
 * freed by `removeShares` is redeployed instead of leaking to lending.
 */
export interface RebalancePlan {
  pmId: string;
  /** Liquidity shares to remove, keyed by current bin id. Empty = skip remove step. */
  removeShares: Map<number, bigint>;
  /** Total amounts to feed into agent_add_liquidity (sum of `add.perBin`). */
  addAmountA: bigint;
  addAmountB: bigint;
  /** Per-bin distribution. bins[], amountsA[], amountsB[] must be the same length. */
  addBins: number[];
  addAmountsA: bigint[];
  addAmountsB: bigint[];
  /** Whether to call agent_collect_fee + transfer_fee_to_balance before adding. */
  collectFees: boolean;
  /** Free-form rationale captured into the rebalance journal. */
  reason: string;
  /**
   * The pool's active bin id at plan time. The execution layer aborts (and,
   * when SLIPPAGE_GUARD_ONCHAIN is on, the PTB asserts on-chain) if the live
   * active bin has drifted more than `slippageMaxBinDrift` bins away — the
   * pre-computed per-bin split is priced for THIS active bin.
   */
  plannedActiveBinId?: number;
  /**
   * "emergency" marks protective plans (EXTREME full withdrawal) that must
   * bypass churn caps and skip the proceeds re-planning pass. Default
   * (undefined) is treated as "normal".
   */
  priority?: "normal" | "emergency";
}

export interface ExecutionResult {
  pmId: string;
  digest: string;
  status: "succeeded" | "failed";
  error?: string;
  /** Decoded events from the tx that match our agent address. */
  emittedAgentEvents: string[];
}

/** A subscription = a PM that has whitelisted us as agent. Authoritative state lives in DB. */
export interface Subscription {
  pmId: string;
  owner: string;
  poolId: string;
  coinTypeA: string;
  coinTypeB: string;
  status: "active" | "revoked" | "closed";
  addedAtMs: number;
  removedAtMs: number | null;
}
