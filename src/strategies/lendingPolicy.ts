/**
 * Policy knobs for routing idle PositionManager balance into lending.
 *
 * The router consumes one of these per coin type and decides whether to
 * supply (idle balance is large enough to earn), redeem (we need more balance
 * for a pending bin operation), or switch protocols (APY delta exceeds
 * hysteresis).
 */
export interface LendingCoinPolicy {
  /**
   * Keep at least this much in the PM balance Bag for gas / micro-adjustments.
   * Idle above this floor is eligible for supply.
   */
  minIdleBuffer: bigint;
  /**
   * Don't trigger a supply unless `idle - minIdleBuffer >= supplyThreshold`.
   * Avoids burning gas on dust amounts.
   */
  supplyThreshold: bigint;
  /**
   * When redeeming to cover a planned bin add, pull this much extra to absorb
   * slippage between the off-chain prediction and on-chain settle.
   */
  redeemHeadroom: bigint;
  /**
   * Only switch protocols when one APY exceeds the other by this many basis
   * points. 50 bp default keeps churn down when APYs are within noise.
   */
  apySwitchDeltaBps: number;
}

export interface LendingPolicy {
  enabled: boolean;
  apyCacheTtlMs: number;
  /** Per-coin policy, keyed by fully-qualified coin type tag. */
  perCoin: Record<string, LendingCoinPolicy>;
  protocols: {
    scallop: { enabled: boolean };
    kai: { enabled: boolean };
  };
}

export function defaultLendingCoinPolicy(): LendingCoinPolicy {
  return {
    minIdleBuffer: 0n,
    supplyThreshold: 0n,
    redeemHeadroom: 0n,
    apySwitchDeltaBps: 50,
  };
}
