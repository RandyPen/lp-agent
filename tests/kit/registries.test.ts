/**
 * The fork seam. These registries are the framework's product surface: a fork
 * must be able to add a strategy / pool / feed WITHOUT editing framework files,
 * and must be told loudly when it collides with something that already exists.
 */

import { describe, it, expect, afterEach } from "bun:test";
import {
  registerStrategy,
  buildStrategy,
  isStrategyName,
  listStrategyNames,
  resetCustomStrategiesForTests,
} from "../../src/strategies/registry.ts";
import {
  registerPool,
  loadPoolProfile,
  listPoolNames,
  resetCustomPoolsForTests,
} from "../../src/pools/index.ts";
import {
  registerPriceFeed,
  buildPriceFeed,
  isPriceFeedName,
  listPriceFeedNames,
  resetCustomFeedsForTests,
} from "../../src/data/feedRegistry.ts";
import { ConfigError } from "../../src/lib/errors.ts";
import type { Strategy } from "../../src/strategies/types.ts";
import type { PoolProfile } from "../../src/pools/types.ts";
import type { PriceFeed } from "../../src/data/priceFeed.ts";

function fakeStrategy(name: string): Strategy {
  return {
    name,
    async plan() {
      return { kind: "quiet", reason: `${name}: test` };
    },
  };
}

function fakeProfile(name: string): PoolProfile {
  return {
    name,
    poolId: "0xfork-pool",
    coinTypeA: "0x2::sui::SUI",
    coinTypeB: "0xusdc::usdc::USDC",
    decimalsA: 9,
    decimalsB: 6,
    binStep: 25,
    pricePairLabel: "FORK/USDC",
    defaultStrategyParams: { binWidth: 4, expectedFeeBps: 30 },
    lendingPolicy: {},
    network: "mainnet",
  };
}

function fakeFeed(source: string): PriceFeed {
  return {
    source,
    async getSpot() {
      return { price: "1.0", timestampMs: 0, source };
    },
    async getHistory() {
      return [];
    },
    async getOhlcv() {
      return [];
    },
  };
}

afterEach(() => {
  resetCustomStrategiesForTests();
  resetCustomPoolsForTests();
  resetCustomFeedsForTests();
});

describe("strategy registry", () => {
  it("resolves a fork-registered strategy by name", () => {
    expect(isStrategyName("forkStrat")).toBe(false);

    registerStrategy("forkStrat", () => fakeStrategy("forkStrat"));

    expect(isStrategyName("forkStrat")).toBe(true);
    expect(listStrategyNames()).toContain("forkStrat");
    expect(buildStrategy("forkStrat").name).toBe("forkStrat");
  });

  it("still resolves the built-ins", () => {
    expect(buildStrategy("multiBinSpot").name).toBe("multiBinSpot");
    expect(isStrategyName("presenceAnchor")).toBe(true);
  });

  it("refuses to shadow a built-in — the agent would trade code the operator did not select", () => {
    expect(() => registerStrategy("multiBinSpot", () => fakeStrategy("x"))).toThrow(ConfigError);
    expect(() => registerStrategy("mlAgent", () => fakeStrategy("x"))).toThrow(ConfigError);
  });

  it("refuses a duplicate registration", () => {
    registerStrategy("dupe", () => fakeStrategy("dupe"));
    expect(() => registerStrategy("dupe", () => fakeStrategy("dupe"))).toThrow(ConfigError);
  });

  it("names the available strategies when one is unknown", () => {
    expect(() => buildStrategy("nope")).toThrow(/unknown strategy: 'nope'/);
    expect(() => buildStrategy("nope")).toThrow(/multiBinSpot/);
  });

  it("still requires mlDeps for mlAgent", () => {
    expect(() => buildStrategy("mlAgent")).toThrow(ConfigError);
  });
});

describe("pool registry", () => {
  it("resolves a fork-registered pool profile", () => {
    registerPool("fork-usdc", () => fakeProfile("fork-usdc"));

    expect(listPoolNames()).toContain("fork-usdc");
    expect(loadPoolProfile("fork-usdc").binStep).toBe(25);
  });

  it("refuses to shadow a built-in", () => {
    expect(() => registerPool("sui-usdc", () => fakeProfile("sui-usdc"))).toThrow(ConfigError);
  });

  it("requires a poolId by default, but not when the caller opts out", () => {
    registerPool("empty", () => ({ ...fakeProfile("empty"), poolId: "" }));

    expect(() => loadPoolProfile("empty")).toThrow(/empty poolId/);
    // The offline backtest uses the profile purely as metadata and supplies the
    // price series key itself, so it must not be forced to set an on-chain id.
    expect(loadPoolProfile("empty", { requirePoolId: false }).name).toBe("empty");
  });
});

describe("price feed registry", () => {
  it("resolves a fork-registered feed", () => {
    expect(isPriceFeedName("pyth")).toBe(false);

    registerPriceFeed("pyth", () => fakeFeed("pyth"));

    expect(isPriceFeedName("pyth")).toBe(true);
    expect(listPriceFeedNames()).toContain("pyth");
    expect(buildPriceFeed("pyth", fakeProfile("p")).source).toBe("pyth");
  });

  it("ships onchain and binance as built-ins", () => {
    expect(isPriceFeedName("onchain")).toBe(true);
    expect(isPriceFeedName("binance")).toBe(true);
  });

  it("names the available feeds when one is unknown", () => {
    // 'pyth' used to be an accepted PRICE_FEED value that then called
    // process.exit(1) at startup. It is now simply not registered, and the
    // error says how to add it.
    expect(() => buildPriceFeed("pyth", fakeProfile("p"))).toThrow(/unknown PRICE_FEED='pyth'/);
    expect(() => buildPriceFeed("pyth", fakeProfile("p"))).toThrow(/agent\.config\.ts/);
  });
});
