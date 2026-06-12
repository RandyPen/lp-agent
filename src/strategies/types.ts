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

/**
 * Strategies return one of four kinds of output (worker reference §7):
 *
 * - `plan_and_reconcile`: execute the rebalance PTB *and* run the post-plan
 *   lending reconciliation (cover shortfall + deploy idle). This is the
 *   normal path for most rebalances.
 * - `plan_only`: execute the rebalance PTB but skip the lending step. Used
 *   when the strategy is doing a tactical move (e.g. fee harvest) that
 *   shouldn't disturb the lending position.
 * - `reconcile_only`: no rebalance, just run lending. Used when the strategy
 *   is content with the current position shape but wants to capture idle
 *   yield or cover a shortfall.
 * - `quiet`: do nothing this tick.
 *
 * Optional fields:
 * - `fillBoundary`: a bin id that bid-ask / only-bid strategies persist into
 *   `position_state` so the next tick knows which side of the active bin to
 *   leave idle. v0 strategies (singleBin, multiBinSpot) don't emit this.
 */
export type StrategyOutput =
  | { kind: "plan_and_reconcile"; plan: RebalancePlan; fillBoundary?: number }
  | { kind: "plan_only"; plan: RebalancePlan; fillBoundary?: number }
  | { kind: "reconcile_only"; reason: string }
  | { kind: "quiet"; reason: string };

export interface Strategy {
  readonly name: string;
  /**
   * Given a PM snapshot + pool state + price observations, decide what to do.
   * v0 strategies should return a `StrategyOutput`. `null` is no longer
   * accepted; emit `{ kind: "quiet" }` instead.
   *
   * The signature is async so that v1 mlAgent can await the prediction sidecar
   * without needing a synchronous cache layer. v0 rule-based strategies
   * implement this with `async plan(...)` and bodies that remain synchronous.
   */
  plan(input: StrategyInput): Promise<StrategyOutput>;
}
