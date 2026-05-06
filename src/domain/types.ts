/**
 * Shared domain types. These are the seams between the on-chain layer (sui/),
 * the data layer (data/), the strategy layer (strategies/), and the orchestration
 * layer (services/). All bigints are kept as bigints; all on-chain string ids
 * (object ids, type tags) are kept as strings.
 */

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
