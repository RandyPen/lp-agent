import type { PoolProfile } from "../pools/types.ts";
import type {
  PMState,
  PoolState,
  PriceObservation,
  RebalancePlan,
} from "../domain/types.ts";
import type { MarketSnapshot, StateContext } from "../prediction/types.ts";

export interface StrategyInput {
  pm: PMState;
  pool: PoolState;
  spot: PriceObservation;
  history: PriceObservation[];
  profile: PoolProfile;
  /**
   * The full market snapshot the framework already assembles: derivatives
   * (funding rate, open interest, 1m liquidation flow), cross-asset BTC/ETH
   * OHLCV, pool TVL, and the Cetus-vs-Binance spread.
   *
   * Previously this was reachable only by `mlAgent` (through `MlAgentDeps`),
   * so every other strategy — including every fork strategy — saw nothing but
   * price ticks. That made fork strategies second-class by construction.
   *
   * OPTIONAL, and you must handle its absence:
   *   - live rebalancer / shadow runner: PRESENT (the market aggregator is running).
   *   - offline backtest and the shadow fleet: ABSENT (no aggregator; the
   *     backtest replays persisted history, which does not carry derivatives).
   *
   * So a strategy that hard-depends on `snapshot` cannot be backtested offline.
   * That is a real trade-off, not an oversight: degrade to `history` when it is
   * undefined, or accept that your strategy is shadow-only. Never fabricate the
   * missing values — `undefined` means "not observed", which is different from
   * zero (see `DataOutageError` in src/data/marketAggregator.ts).
   */
  snapshot?: MarketSnapshot;
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
 * - `stateCtx`: the state context that produced this output. mlAgent emits
 *   its state machine's advance()-derived context (lendingPct including the
 *   TREND ramp and any L1 soft-circuit bonus); presenceAnchor emits an
 *   equivalent context from its per-tick vol-regime nowcast. The rebalancer
 *   uses `stateCtx.lendingPct` as the lending router's target fraction and
 *   (for non-mlAgent strategies) journals state transitions into
 *   `market_state_history`. Other rule-based strategies leave it undefined.
 */
export type StrategyOutput =
  | { kind: "plan_and_reconcile"; plan: RebalancePlan; fillBoundary?: number; stateCtx?: StateContext }
  | { kind: "plan_only"; plan: RebalancePlan; fillBoundary?: number; stateCtx?: StateContext }
  | { kind: "reconcile_only"; reason: string; stateCtx?: StateContext }
  | { kind: "quiet"; reason: string };

export interface Strategy {
  readonly name: string;
  /**
   * How much price history (ms) this strategy needs in `StrategyInput.history`.
   * The rebalancer passes this to `priceFeed.getHistory`; absent = the default
   * 5-minute window. Strategies that compute slow anchors or vol regimes
   * (presenceAnchor: 4h) declare their requirement here instead of taking a
   * PriceFeed dependency.
   */
  readonly historyWindowMs?: number;
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
