/**
 * tests/integration/fakes.ts
 *
 * Fake implementations of feed and service interfaces for integration testing.
 * All fakes are in-memory and deterministic.
 */

import type { OhlcvBar } from "../../src/prediction/types.ts";
import type { BinanceMultiFeed, BinanceMultiWindows } from "../../src/data/feeds/binanceMulti.ts";
import type { DerivativesFeed, DerivativesSnapshot } from "../../src/data/feeds/derivatives.ts";
import type { CetusEventsFeed, CetusPoolState } from "../../src/data/feeds/cetusEvents.ts";
import type { MarketAggregator, StalenessInfo } from "../../src/data/marketAggregator.ts";
import type { MarketSnapshot } from "../../src/prediction/types.ts";
import type { ExecutorService } from "../../src/services/executor.ts";
import type { SubscriptionsService } from "../../src/services/subscriptions.ts";
import type { Subscription, PMState, PoolState, RebalancePlan } from "../../src/domain/types.ts";
import type { StrategyInput } from "../../src/strategies/types.ts";
import type { PoolProfile } from "../../src/pools/types.ts";
import type { UnifiedRebalanceInput } from "../../src/sui/cdpm/txUnified.ts";
import type { ExecutionResult } from "../../src/domain/types.ts";
import type { LendingDecision } from "../../src/sui/lending/types.ts";
import { DataOutageError } from "../../src/data/marketAggregator.ts";
import { emptyLendingState } from "../../src/sui/lending/types.ts";
import { POOL_ID, BIN_STEP, BASE_ACTIVE_BIN } from "./simMarket.ts";

// ---------------------------------------------------------------------------
// FakeBinanceMultiFeed
// ---------------------------------------------------------------------------

export class FakeBinanceMultiFeed implements BinanceMultiFeed {
  private suiBars: OhlcvBar[];

  constructor(initialBars: OhlcvBar[] = []) {
    this.suiBars = [...initialBars];
  }

  push(bars: OhlcvBar[]): void {
    this.suiBars.push(...bars);
  }

  latest(): BinanceMultiWindows {
    return {
      sui: [...this.suiBars],
      btc: [...this.suiBars],
      eth: [...this.suiBars],
    };
  }

  latest1m(): BinanceMultiWindows {
    return this.latest();
  }

  latest5m(): BinanceMultiWindows {
    return this.latest();
  }

  lastUpdatedMs(): number {
    if (this.suiBars.length === 0) return 0;
    return this.suiBars[this.suiBars.length - 1]!.ts;
  }

  symbolLastUpdatedMs(_symbol: string, _interval: "1m" | "5m"): number {
    return this.lastUpdatedMs();
  }

  start(): () => void {
    return () => {};
  }
}

// ---------------------------------------------------------------------------
// FakeDerivativesFeed
// ---------------------------------------------------------------------------

export class FakeDerivativesFeed implements DerivativesFeed {
  private readonly initialTs: number;

  constructor(initialTs: number = 0) {
    this.initialTs = initialTs;
  }

  latest(): DerivativesSnapshot {
    return { funding: 0.0001, oi: 1_000_000, liq1m: 0 };
  }

  lastUpdatedMs(): number {
    return this.initialTs;
  }

  start(): () => void {
    return () => {};
  }
}

// ---------------------------------------------------------------------------
// FakeCetusEventsFeed
// ---------------------------------------------------------------------------

export interface FakeCetusState {
  activeBin: number;
  price: string;
  tvlUsd: number;
  binStep: number;
  ts: number;
}

export class FakeCetusEventsFeed implements CetusEventsFeed {
  private state: FakeCetusState;

  constructor(state: FakeCetusState) {
    this.state = { ...state };
  }

  update(data: Partial<FakeCetusState>): void {
    this.state = { ...this.state, ...data };
  }

  latest(): CetusPoolState {
    return {
      activeBin: this.state.activeBin,
      price: this.state.price,
      tvlUsd: this.state.tvlUsd,
      binStep: this.state.binStep,
    };
  }

  lastUpdatedMs(): number {
    return this.state.ts;
  }

  start(): () => void {
    return () => {};
  }
}

// ---------------------------------------------------------------------------
// FakeMarketAggregator
// ---------------------------------------------------------------------------

export class FakeMarketAggregator implements MarketAggregator {
  private snapshot: MarketSnapshot | null;

  constructor(initialSnapshot?: MarketSnapshot) {
    this.snapshot = initialSnapshot ?? null;
  }

  setSnapshot(snapshot: MarketSnapshot): void {
    this.snapshot = snapshot;
  }

  latest(): MarketSnapshot {
    if (this.snapshot === null) {
      throw new DataOutageError(["binance", "derivatives", "cetus"]);
    }
    return this.snapshot;
  }

  staleness(): StalenessInfo {
    return { sui: 0, btc: 0, eth: 0, derivatives: 0, cetus: 0 };
  }

  allSourcesDown(_maxAgeMs: number): boolean {
    return false;
  }

  start(): () => void {
    return () => {};
  }
}

export function createFakeMarketAggregator(
  initialSnapshot?: MarketSnapshot,
): FakeMarketAggregator {
  return new FakeMarketAggregator(initialSnapshot);
}

// ---------------------------------------------------------------------------
// FakeExecutorService
// ---------------------------------------------------------------------------

export interface RecordedPlan {
  pmId: string;
  plan: RebalancePlan;
  submittedAtMs: number;
}

let _fakeDigestCounter = 0;

export class FakeExecutorService implements ExecutorService {
  readonly submissions: RecordedPlan[] = [];
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  async submitUnifiedRebalance(input: UnifiedRebalanceInput): Promise<ExecutionResult> {
    this.submissions.push({
      pmId: input.plan.pmId,
      plan: input.plan,
      submittedAtMs: this.now(),
    });
    return {
      pmId: input.plan.pmId,
      digest: `fake-digest-${++_fakeDigestCounter}`,
      status: "succeeded",
      emittedAgentEvents: [],
    };
  }

  async addLiquidity(plan: RebalancePlan, _pm: PMState): Promise<ExecutionResult> {
    this.submissions.push({ pmId: plan.pmId, plan, submittedAtMs: this.now() });
    return {
      pmId: plan.pmId,
      digest: `fake-digest-${++_fakeDigestCounter}`,
      status: "succeeded",
      emittedAgentEvents: [],
    };
  }

  async removeLiquidity(plan: RebalancePlan, _pm: PMState): Promise<ExecutionResult> {
    this.submissions.push({ pmId: plan.pmId, plan, submittedAtMs: this.now() });
    return {
      pmId: plan.pmId,
      digest: `fake-digest-${++_fakeDigestCounter}`,
      status: "succeeded",
      emittedAgentEvents: [],
    };
  }

  async collectAndTransferFees(pmId: string, _pm: PMState): Promise<ExecutionResult> {
    return {
      pmId,
      digest: `fake-digest-${++_fakeDigestCounter}`,
      status: "succeeded",
      emittedAgentEvents: [],
    };
  }

  async supplyToLending(
    decision: Extract<LendingDecision, { kind: "supply" }>,
  ): Promise<ExecutionResult> {
    return {
      pmId: decision.pmId,
      digest: `fake-digest-${++_fakeDigestCounter}`,
      status: "succeeded",
      emittedAgentEvents: [],
    };
  }

  async redeemFromLending(
    decision: Extract<LendingDecision, { kind: "redeem" }>,
  ): Promise<ExecutionResult> {
    return {
      pmId: decision.pmId,
      digest: `fake-digest-${++_fakeDigestCounter}`,
      status: "succeeded",
      emittedAgentEvents: [],
    };
  }
}

// ---------------------------------------------------------------------------
// FakeSubscriptionsService
// ---------------------------------------------------------------------------

export class FakeSubscriptionsService implements SubscriptionsService {
  private subs: Subscription[];

  constructor(initialSubs: Subscription[] = []) {
    this.subs = [...initialSubs];
  }

  listActive(): Subscription[] {
    return this.subs.filter((s) => s.status === "active");
  }

  get(pmId: string): Subscription | null {
    return this.subs.find((s) => s.pmId === pmId) ?? null;
  }

  async pollOnce(): Promise<{ added: number; removed: number; closed: number }> {
    return { added: 0, removed: 0, closed: 0 };
  }
}

// ---------------------------------------------------------------------------
// Helper builders
// ---------------------------------------------------------------------------

const SUI_COIN_TYPE = "0x2::sui::SUI";
const USDC_COIN_TYPE = "0x5d4b302506645c37ff133b98c4b50a4ae4614bb0efbf4adcc67a9b4b7b1e7e4f::coin::COIN";

export function makeFakePmState(overrides?: Partial<PMState>): PMState {
  return {
    pmId: "0xfakepm",
    owner: "0xfakeowner",
    poolId: POOL_ID,
    coinTypeA: SUI_COIN_TYPE,
    coinTypeB: USDC_COIN_TYPE,
    balance: { a: 1_000_000_000n, b: 3_500_000n }, // 1 SUI + 3.5 USDC (9/6 decimals)
    feeBag: { a: 0n, b: 0n },
    positionBins: [],
    lending: emptyLendingState(),
    ...overrides,
  };
}

/**
 * Build a PM state with an open position spanning ±halfWidth bins around the
 * given active bin. This ensures NullProvider computes pAbove + pBelow against
 * the actual position range (rather than the ±0.5 bin default for empty positions),
 * preventing the pBreakSum circuit from spuriously firing in tests that are not
 * testing the crash/extreme scenario.
 *
 * With σ_bins≈3.2 and halfWidth=4:
 *   pAbove ≈ 1 − Φ(4/3.2) ≈ 0.106, pBelow ≈ 0.106 → sum ≈ 0.21 << 0.7
 */
export function makeFakePmStateWithPosition(
  activeBin: number,
  halfWidth: number = 4,
  overrides?: Partial<PMState>,
): PMState {
  const binIds: number[] = [];
  for (let d = -halfWidth; d <= halfWidth; d++) {
    if (d !== 0) binIds.push(activeBin + d); // skip active bin itself (DLMM invariant)
  }
  const positionBins = binIds.map((binId) => ({
    binId,
    liquidityShare: 1_000_000n,
    amountA: 50_000_000n,
    amountB: 175_000n,
  }));
  return makeFakePmState({ positionBins, ...overrides });
}

export function makeFakePoolState(activeBin: number = BASE_ACTIVE_BIN): PoolState {
  return {
    poolId: POOL_ID,
    activeBinId: activeBin,
    binStep: BIN_STEP,
    feeRateBps: 40,
  };
}

export function makeFakeStrategyInput(pm?: PMState, pool?: PoolState): StrategyInput {
  const resolvedPm = pm ?? makeFakePmState();
  const resolvedPool = pool ?? makeFakePoolState();

  const profile: PoolProfile = {
    name: "sui-usdc",
    poolId: POOL_ID,
    coinTypeA: SUI_COIN_TYPE,
    coinTypeB: USDC_COIN_TYPE,
    decimalsA: 9,
    decimalsB: 6,
    binStep: BIN_STEP,
    pricePairLabel: "SUI/USDC",
    defaultStrategyParams: { binWidth: 10, expectedFeeBps: 40 },
    lendingPolicy: {},
    network: "mainnet",
  };

  return {
    pm: resolvedPm,
    pool: resolvedPool,
    spot: {
      price: "3.5000000000",
      timestampMs: Date.now(),
      source: "fake",
    },
    history: [],
    profile,
  };
}
