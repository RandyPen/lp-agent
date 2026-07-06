/**
 * tests/sui/lending/apyCache.test.ts — TTL caching semantics for getApy().
 *
 * getScallopAdapter()/getKaiAdapter() are real module-level singletons with no
 * injection seam, so the adapter modules themselves are swapped out via
 * `mock.module` before importing apyCache — the only way to control what
 * "the SDK call" returns without touching src/sui/lending/scallop.ts or
 * kai.ts (out of scope for this fix).
 *
 * Fix 4 contract under test:
 *   - A real snapshot is cached and served until the TTL expires.
 *   - A legitimate `null` result is ALSO cached (previously it was not,
 *     defeating the TTL for unsupported coins).
 *   - A thrown fetch error is never cached and never coerced to `null` — it
 *     propagates to the caller.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

const scallopCalls: string[] = [];
let scallopBehavior: (coinType: string) => Promise<unknown>;

mock.module("../../../src/sui/lending/scallop.ts", () => ({
  getScallopAdapter: () => ({
    getSupplyApy: async (coinType: string) => {
      scallopCalls.push(coinType);
      return scallopBehavior(coinType);
    },
  }),
}));

mock.module("../../../src/sui/lending/kai.ts", () => ({
  getKaiAdapter: () => ({
    getSupplyApy: async () => {
      throw new Error("kai adapter not used in this test file");
    },
  }),
}));

const { resetConfigCacheForTests } = await import("../../../src/config.ts");
const { getApy, resetApyCacheForTests } = await import("../../../src/sui/lending/apyCache.ts");

const REQUIRED_ENV: Record<string, string> = {
  AGENT_PRIVATE_KEY: "suiprivkey1qr3twlseqm4qj5sr7mqhz3yyx7wrluu3qn39nj6jxpsxufe46mul574lteq",
  SUI_USDC_POOL_ID: "0xpool",
  EXPECTED_AGENT_ADDRESS: "0xf3f8feeba6b94376511dfc38d51ea3f5d2f3d1b70725fa0f50e5253a66d0d0b9",
  IDENTITY_FILES_DISABLED: "true",
  LENDING_ENABLED: "false",
};
for (const [k, v] of Object.entries(REQUIRED_ENV)) process.env[k] = v;
resetConfigCacheForTests();

const COIN = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";

beforeEach(() => {
  scallopCalls.length = 0;
  resetApyCacheForTests();
});

describe("apyCache getApy", () => {
  it("caches a real snapshot and serves it without re-fetching within the TTL", async () => {
    scallopBehavior = async (coinType) => ({
      protocol: "scallop",
      coinType,
      apy: 0.05,
      observedAtMs: Date.now(),
    });

    const first = await getApy("scallop", COIN);
    const second = await getApy("scallop", COIN);

    expect(first?.apy).toBe(0.05);
    expect(second?.apy).toBe(0.05);
    expect(scallopCalls.length).toBe(1); // second call served from cache
  });

  it("caches a legitimate null result too — the TTL actually bounds RPC load", async () => {
    scallopBehavior = async () => null;

    const first = await getApy("scallop", COIN);
    const second = await getApy("scallop", COIN);
    const third = await getApy("scallop", COIN);

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(third).toBeNull();
    // Without Fix 4 this would be 3 (one fetch per call, defeating the TTL).
    expect(scallopCalls.length).toBe(1);
  });

  it("re-fetches after the TTL actually expires, for both real and null results", async () => {
    const prevTtl = process.env.LENDING_APY_CACHE_TTL_MS;
    process.env.LENDING_APY_CACHE_TTL_MS = "20";
    resetConfigCacheForTests();
    resetApyCacheForTests();
    try {
      scallopBehavior = async () => null;
      await getApy("scallop", COIN);
      expect(scallopCalls.length).toBe(1);

      // Still within the 20ms TTL — served from cache.
      await getApy("scallop", COIN);
      expect(scallopCalls.length).toBe(1);

      await new Promise((r) => setTimeout(r, 30));

      await getApy("scallop", COIN);
      expect(scallopCalls.length).toBe(2);
    } finally {
      if (prevTtl !== undefined) process.env.LENDING_APY_CACHE_TTL_MS = prevTtl;
      else delete process.env.LENDING_APY_CACHE_TTL_MS;
      resetConfigCacheForTests();
    }
  });

  it("propagates a thrown fetch error instead of coercing it to null, and does not cache it", async () => {
    let calls = 0;
    scallopBehavior = async () => {
      calls++;
      throw new Error("scallop RPC unreachable");
    };

    await expect(getApy("scallop", COIN)).rejects.toThrow(/scallop RPC unreachable/);
    expect(calls).toBe(1);

    // Not cached — the next call hits the adapter again (and fails again).
    await expect(getApy("scallop", COIN)).rejects.toThrow(/scallop RPC unreachable/);
    expect(calls).toBe(2);
  });

  it("de-dupes concurrent in-flight requests for the same key", async () => {
    let calls = 0;
    scallopBehavior = async (coinType) => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return { protocol: "scallop", coinType, apy: 0.03, observedAtMs: Date.now() };
    };

    const [a, b] = await Promise.all([getApy("scallop", COIN), getApy("scallop", COIN)]);
    expect(a?.apy).toBe(0.03);
    expect(b?.apy).toBe(0.03);
    expect(calls).toBe(1);
  });
});
