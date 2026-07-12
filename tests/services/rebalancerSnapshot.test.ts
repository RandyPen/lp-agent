/**
 * The rebalancer must hand every strategy the assembled MarketSnapshot —
 * not just mlAgent.
 *
 * Before this, `StrategyInput` carried price ticks only, and the funding rate /
 * open interest / liquidation flow / cross-asset bars the framework works hard
 * to collect were reachable exclusively through `MlAgentDeps`. Fork strategies
 * were second-class by construction: to use any of it, you had to fork the
 * framework — which is exactly what the extension seam exists to prevent.
 *
 * The two behaviours pinned here:
 *   1. snapshot is PRESENT when the aggregator has data.
 *   2. a DataOutageError degrades to `snapshot: undefined` WITHOUT killing the
 *      tick — a price-only strategy must keep trading through a derivatives
 *      outage. `undefined` means "not observed"; it is never fabricated as 0.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import type { PMState, PoolState } from "../../src/domain/types.ts";
import type { StrategyInput } from "../../src/strategies/types.ts";
import type { SubscriptionsService } from "../../src/services/subscriptions.ts";

const REQUIRED_ENV: Record<string, string> = {
  AGENT_PRIVATE_KEY: "suiprivkey1qr3twlseqm4qj5sr7mqhz3yyx7wrluu3qn39nj6jxpsxufe46mul574lteq",
  SUI_USDC_POOL_ID: "0xpool",
  EXPECTED_AGENT_ADDRESS: "", // derived from the key below
  IDENTITY_FILES_DISABLED: "true",
  LENDING_ENABLED: "false",
  TREASURY_ENABLED: "false",
  ML_SHADOW_MODE: "false",
  DB_FILE: ":memory:",
};
const origEnv: Record<string, string | undefined> = {};

const BASE_ACTIVE_BIN = 1445;
const POOL_ID = "0xpool";
const PM_ID = "0xpm";

let pmState: PMState;
let poolState: PoolState;

mock.module("../../src/sui/cdpm/read.ts", () => ({
  getPositionManager: async () => pmState,
  isAgentAuthorized: async () => true,
}));
mock.module("../../src/sui/pool.ts", () => ({
  getPoolState: async () => poolState,
}));

const { openDb, resetDbCacheForTests } = await import("../../src/db/client.ts");
const { resetConfigCacheForTests } = await import("../../src/config.ts");
const { resetKeypairCacheForTests } = await import("../../src/sui/keypair.ts");
const { createRiskMonitor } = await import("../../src/risk/monitor.ts");
const { createRebalancerService } = await import("../../src/services/rebalancer.ts");
const { registerStrategy, resetCustomStrategiesForTests } =
  await import("../../src/strategies/registry.ts");
const { FakeMarketAggregator, FakeExecutorService, makeFakePmState, makeFakePoolState } =
  await import("../integration/fakes.ts");

/** Captures whatever StrategyInput the rebalancer builds. */
let captured: StrategyInput | null = null;

function fakeSubscriptions(): SubscriptionsService {
  const sub = {
    pmId: PM_ID,
    owner: "0xowner",
    poolId: POOL_ID,
    coinTypeA: "0xusdc::usdc::USDC",
    coinTypeB: "0x2::sui::SUI",
    addedAtMs: Date.now(),
    removedAtMs: null,
  };
  return {
    listActive: () => [sub],
    pollOnce: async () => ({ added: 0, removed: 0 }),
  } as unknown as SubscriptionsService;
}

const priceFeed = {
  source: "test",
  getSpot: async () => ({ price: "1.00", timestampMs: Date.now(), source: "test" }),
  getHistory: async () => [{ price: "1.00", timestampMs: Date.now(), source: "test" }],
  getOhlcv: async () => [],
};

beforeEach(async () => {
  const { decodeSuiPrivateKey } = await import("@mysten/sui/cryptography");
  const { Ed25519Keypair } = await import("@mysten/sui/keypairs/ed25519");
  const { secretKey } = decodeSuiPrivateKey(REQUIRED_ENV.AGENT_PRIVATE_KEY!);
  REQUIRED_ENV.EXPECTED_AGENT_ADDRESS = Ed25519Keypair.fromSecretKey(secretKey).toSuiAddress();
  for (const [k, v] of Object.entries(REQUIRED_ENV)) {
    origEnv[k] = process.env[k];
    process.env[k] = v;
  }

  resetDbCacheForTests();
  resetConfigCacheForTests();
  resetKeypairCacheForTests();
  resetCustomStrategiesForTests();
  captured = null;

  openDb(":memory:");

  pmState = makeFakePmState({ pmId: PM_ID, poolId: POOL_ID });
  poolState = makeFakePoolState(BASE_ACTIVE_BIN);

  // A strategy that does nothing but record what it was given.
  registerStrategy("capture", () => ({
    name: "capture",
    async plan(input: StrategyInput) {
      captured = input;
      return { kind: "quiet" as const, reason: "capture" };
    },
  }));
});

afterEach(() => {
  resetCustomStrategiesForTests();
  resetDbCacheForTests();
  for (const k of Object.keys(REQUIRED_ENV)) {
    if (origEnv[k] !== undefined) process.env[k] = origEnv[k];
    else delete process.env[k];
  }
});

async function runOneTick(aggregator?: InstanceType<typeof FakeMarketAggregator>): Promise<void> {
  const { loadConfig } = await import("../../src/config.ts");
  const { getDb } = await import("../../src/db/client.ts");
  const cfg = loadConfig();
  const riskMonitor = createRiskMonitor({
    db: getDb(),
    thresholds: cfg.risk.thresholds,
    l3: cfg.risk.l3,
  });

  const rebalancer = createRebalancerService(
    fakeSubscriptions(),
    new FakeExecutorService(),
    priceFeed,
    {
      riskMonitor,
      liveStrategyName: "capture",
      ...(aggregator ? { marketAggregator: aggregator } : {}),
    },
  );

  await rebalancer.tickOne(PM_ID);
}

describe("rebalancer → StrategyInput.snapshot", () => {
  it("hands the MarketSnapshot to a NON-ML strategy", async () => {
    const aggregator = new FakeMarketAggregator();
    aggregator.setSnapshot({
      ts: Date.now(),
      cetus: { activeBin: BASE_ACTIVE_BIN, price: "1.00", tvlUsd: 1_000_000, binStep: 50 },
      binance: { sui: [], btc: [], eth: [] },
      derivatives: { funding: 0.0001, oi: 5_000_000, liq1m: 1_234 },
      spread: 0.0002,
    });

    await runOneTick(aggregator);

    expect(captured).not.toBeNull();
    // The whole point: a rule-based strategy can now see derivatives.
    expect(captured!.snapshot).toBeDefined();
    expect(captured!.snapshot!.derivatives.funding).toBe(0.0001);
    expect(captured!.snapshot!.derivatives.oi).toBe(5_000_000);
    expect(captured!.snapshot!.derivatives.liq1m).toBe(1_234);
  });

  it("degrades to undefined on a data outage — the tick still runs", async () => {
    // An empty FakeMarketAggregator throws DataOutageError from latest().
    const aggregator = new FakeMarketAggregator();

    await runOneTick(aggregator);

    // The tick completed (the strategy ran) and got price-only input.
    expect(captured).not.toBeNull();
    expect(captured!.snapshot).toBeUndefined();
    // Never fabricated: undefined means "not observed", not zero.
    expect(captured!.spot.price).toBe("1.00");
  });

  it("omits the snapshot entirely when no aggregator is wired (backtest path)", async () => {
    await runOneTick(undefined);

    expect(captured).not.toBeNull();
    expect(captured!.snapshot).toBeUndefined();
  });
});
