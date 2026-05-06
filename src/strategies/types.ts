import type { PoolProfile } from "../pools/types.ts";
import type {
  PMState,
  PoolState,
  PriceObservation,
  RebalancePlan,
} from "../domain/types.ts";

export interface StrategyInput {
  pm: PMState;
  pool: PoolState;
  spot: PriceObservation;
  history: PriceObservation[];
  profile: PoolProfile;
}

export interface Strategy {
  readonly name: string;
  /**
   * Given a PM snapshot + pool state + price observations, decide what to do.
   * Return null to skip this tick (no rebalance needed).
   */
  plan(input: StrategyInput): RebalancePlan | null;
}
