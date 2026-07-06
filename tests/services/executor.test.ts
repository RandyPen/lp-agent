/**
 * tests/services/executor.test.ts
 *
 * Executor seams that never had coverage:
 *   - decodeRemoveProceedsFromDryRun (pure event decoding + failure loudness)
 *   - estimateRemoveProceeds short-circuits for plans that remove nothing
 *   - failure branches return status:"failed" instead of throwing
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  createExecutorService,
  decodeRemoveProceedsFromDryRun,
} from "../../src/services/executor.ts";
import { EVENT_TYPES } from "../../src/sui/cdpm/package.ts";
import type { PMState, RebalancePlan } from "../../src/domain/types.ts";
import type { SuiClient } from "../../src/sui/client.ts";
import { emptyLendingState } from "../../src/sui/lending/types.ts";
import { resetConfigCacheForTests } from "../../src/config.ts";
import { resetKeypairCacheForTests } from "../../src/sui/keypair.ts";

const REQUIRED_ENV: Record<string, string> = {
  AGENT_PRIVATE_KEY: "suiprivkey1qr3twlseqm4qj5sr7mqhz3yyx7wrluu3qn39nj6jxpsxufe46mul574lteq",
  SUI_USDC_POOL_ID: "0xpool",
  EXPECTED_AGENT_ADDRESS: "",
  IDENTITY_FILES_DISABLED: "true",
  LENDING_ENABLED: "false",
};
const origEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  const { decodeSuiPrivateKey } = await import("@mysten/sui/cryptography");
  const { Ed25519Keypair } = await import("@mysten/sui/keypairs/ed25519");
  const { secretKey } = decodeSuiPrivateKey(REQUIRED_ENV.AGENT_PRIVATE_KEY!);
  REQUIRED_ENV.EXPECTED_AGENT_ADDRESS = Ed25519Keypair.fromSecretKey(secretKey).toSuiAddress();
  for (const [k, v] of Object.entries(REQUIRED_ENV)) {
    origEnv[k] = process.env[k];
    process.env[k] = v;
  }
  resetConfigCacheForTests();
  resetKeypairCacheForTests();
});

afterAll(() => {
  for (const k of Object.keys(REQUIRED_ENV)) {
    if (origEnv[k] !== undefined) process.env[k] = origEnv[k];
    else delete process.env[k];
  }
  resetConfigCacheForTests();
  resetKeypairCacheForTests();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SUI = "0x2::sui::SUI";
const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";

function makePm(): PMState {
  return {
    pmId: "0x" + "1".repeat(64),
    owner: "0xowner",
    poolId: "0x" + "2".repeat(64),
    coinTypeA: USDC,
    coinTypeB: SUI,
    balance: { a: 1_000n, b: 2_000n },
    feeBag: { a: 0n, b: 0n },
    positionBins: [],
    lending: emptyLendingState(),
  };
}

function makePlan(overrides: Partial<RebalancePlan> = {}): RebalancePlan {
  return {
    pmId: "0x" + "1".repeat(64),
    removeShares: new Map([[100, 500n]]),
    addAmountA: 0n,
    addAmountB: 0n,
    addBins: [],
    addAmountsA: [],
    addAmountsB: [],
    collectFees: false,
    reason: "test",
    ...overrides,
  };
}

function removedEvent(amountA: string, amountB: string) {
  return {
    type: EVENT_TYPES.AgentLiquidityRemoved,
    parsedJson: {
      pm_id: "0x" + "1".repeat(64),
      pool_id: "0x" + "2".repeat(64),
      bins: [100],
      liquidity_shares: ["500"],
      amount_a: amountA,
      amount_b: amountB,
      by: "0xagent",
    },
  };
}

// ---------------------------------------------------------------------------
// decodeRemoveProceedsFromDryRun (pure)
// ---------------------------------------------------------------------------

describe("decodeRemoveProceedsFromDryRun", () => {
  it("sums AgentLiquidityRemoved amounts across events", () => {
    const dryRun = {
      effects: { status: { status: "success" } },
      events: [removedEvent("1000", "2000"), removedEvent("500", "0")],
    };
    expect(decodeRemoveProceedsFromDryRun(dryRun, "0xpm")).toEqual({ a: 1_500n, b: 2_000n });
  });

  it("ignores unrelated events", () => {
    const dryRun = {
      effects: { status: { status: "success" } },
      events: [
        { type: "0xother::mod::SomethingElse", parsedJson: { amount_a: "999" } },
        removedEvent("100", "200"),
      ],
    };
    expect(decodeRemoveProceedsFromDryRun(dryRun, "0xpm")).toEqual({ a: 100n, b: 200n });
  });

  it("returns zeros when no removal event was emitted", () => {
    const dryRun = { effects: { status: { status: "success" } }, events: [] };
    expect(decodeRemoveProceedsFromDryRun(dryRun, "0xpm")).toEqual({ a: 0n, b: 0n });
  });

  it("throws loudly when the dryRun failed", () => {
    const dryRun = { effects: { status: { status: "failure", error: "MoveAbort code 7" } } };
    expect(() => decodeRemoveProceedsFromDryRun(dryRun, "0xpm")).toThrow(/MoveAbort code 7/);
  });
});

// ---------------------------------------------------------------------------
// estimateRemoveProceeds / failure branches (stub client)
// ---------------------------------------------------------------------------

describe("executor with a stub client", () => {
  // A deliberately empty client: any RPC use throws. Methods must convert
  // that into status:"failed" (never throw), and remove-nothing plans must
  // short-circuit without touching the client at all.
  //
  // Built lazily: createExecutorService resolves the agent keypair via
  // loadConfig(), and the env bootstrap only lands in beforeAll — a
  // module-load-time construction would race it.
  const brokenClient = {} as unknown as SuiClient;
  let executor: ReturnType<typeof createExecutorService>;
  beforeAll(() => {
    executor = createExecutorService({ client: brokenClient });
  });

  it("estimateRemoveProceeds returns zeros without RPC when nothing is removed", async () => {
    const plan = makePlan({ removeShares: new Map() });
    expect(await executor.estimateRemoveProceeds(plan, makePm())).toEqual({ a: 0n, b: 0n });
  });

  it("addLiquidity returns status failed on build errors (no throw)", async () => {
    // Mismatched parallel arrays make buildAddLiquidityTx throw pre-flight;
    // the executor must convert that into status:"failed".
    const plan = makePlan({
      addAmountA: 100n,
      addAmountB: 0n,
      addBins: [101, 102],
      addAmountsA: [100n],
      addAmountsB: [0n],
    });
    const result = await executor.addLiquidity(plan, makePm());
    expect(result.status).toBe("failed");
    expect(result.error).toBeDefined();
  });

  it("removeLiquidity returns status failed on invalid shares (no throw)", async () => {
    const result = await executor.removeLiquidity(
      makePlan({ removeShares: new Map([[100, -5n]]) }),
      makePm(),
    );
    expect(result.status).toBe("failed");
    expect(result.error).toContain("non-negative");
  });

  it("removeLiquidity with an empty remove set succeeds without RPC", async () => {
    const result = await executor.removeLiquidity(makePlan({ removeShares: new Map() }), makePm());
    expect(result.status).toBe("succeeded");
  });

  it("addLiquidity with nothing to add succeeds without RPC", async () => {
    const result = await executor.addLiquidity(makePlan(), makePm());
    expect(result.status).toBe("succeeded");
  });
});
