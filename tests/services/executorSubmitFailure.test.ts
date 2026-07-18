/**
 * tests/services/executorSubmitFailure.test.ts
 *
 * Fix 1 / Fix 2 (src/sui/submit.ts) make submitWithRetry throw
 * OnChainExecutionError when a transaction is committed on-chain but the
 * Move call aborted. This file confirms — by exercising the real code path,
 * not just asserting it by reading — that every executor entry point which
 * calls `submit()` converts that throw into `status: "failed"` rather than
 * letting it escape or silently reporting success.
 *
 * `submitWithRetry` itself is mocked at the module boundary (via
 * `mock.module`) so this test exercises ONLY the executor's catch/convert
 * behavior, without needing a live chain or a fully gas-resolvable PTB.
 * Building the underlying Transaction objects (tx.moveCall / tx.object /
 * tx.pure) is pure/local — no network I/O happens until `.build()`, which is
 * inside the mocked submitWithRetry and therefore never actually runs.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mock } from "bun:test";
import * as realSubmitModule from "../../src/sui/submit.ts";

// `mock.module` is PROCESS-GLOBAL and permanent — it rewrites the module
// registry for every test file that runs after this one in the same `bun test`
// process. Without an explicit restore, tests/sui/submit.test.ts (which tests
// the REAL submitWithRetry) silently gets this stub instead, and fails or
// passes purely on filesystem ordering: macOS happened to load it first, CI's
// Linux ordering loaded it second. Snapshot the genuine exports here — before
// the mock is installed — and re-install them in afterAll below.
const REAL_SUBMIT_EXPORTS = { ...realSubmitModule };

mock.module("../../src/sui/submit.ts", () => {
  class OnChainExecutionError extends Error {
    digest: string;
    effectsError: string;
    constructor(digest: string, effectsError: string) {
      super(`on-chain execution failed for digest ${digest}: ${effectsError}`);
      this.name = "OnChainExecutionError";
      this.digest = digest;
      this.effectsError = effectsError;
    }
  }
  return {
    OnChainExecutionError,
    isTransientRpcError: () => false,
    submitWithRetry: async () => {
      throw new OnChainExecutionError("0xaborted-digest", "MoveAbort(cdpm, 7)");
    },
  };
});

const { createExecutorService } = await import("../../src/services/executor.ts");
const { resetConfigCacheForTests } = await import("../../src/config.ts");
const { resetKeypairCacheForTests } = await import("../../src/sui/keypair.ts");
const { emptyLendingState } = await import("../../src/sui/lending/types.ts");
import type { PMState, RebalancePlan } from "../../src/domain/types.ts";
import type { SuiClient } from "../../src/sui/client.ts";

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
  // Undo the process-global module mock so later test files see the real thing.
  mock.module("../../src/sui/submit.ts", () => REAL_SUBMIT_EXPORTS);
  for (const k of Object.keys(REQUIRED_ENV)) {
    if (origEnv[k] !== undefined) process.env[k] = origEnv[k];
    else delete process.env[k];
  }
  resetConfigCacheForTests();
  resetKeypairCacheForTests();
});

const SUI = "0x2::sui::SUI";
const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";

function makePm(overrides: Partial<PMState> = {}): PMState {
  return {
    pmId: "0x" + "1".repeat(64),
    owner: "0xowner",
    poolId: "0x" + "2".repeat(64),
    coinTypeA: USDC,
    coinTypeB: SUI,
    balance: { a: 1_000n, b: 2_000n },
    feeBag: { a: 500n, b: 0n },
    positionBins: [],
    lending: emptyLendingState(),
    ...overrides,
  };
}

function makePlan(overrides: Partial<RebalancePlan> = {}): RebalancePlan {
  return {
    pmId: "0x" + "1".repeat(64),
    removeShares: new Map([[100, 500n]]),
    addAmountA: 100n,
    addAmountB: 0n,
    addBins: [101],
    addAmountsA: [100n],
    addAmountsB: [0n],
    collectFees: false,
    reason: "test",
    ...overrides,
  };
}

describe("executor converts a committed on-chain abort into status:failed", () => {
  // Never actually dereferenced — submitWithRetry is mocked and never touches it.
  const unusedClient = {} as unknown as SuiClient;
  // Built lazily in beforeAll (not at describe-body eval time): createExecutorService
  // resolves the agent keypair via loadConfig(), and the env bootstrap only
  // lands in the outer beforeAll above — constructing at module-eval time
  // would race it and see an unconfigured environment.
  let executor: ReturnType<typeof createExecutorService>;
  beforeAll(() => {
    executor = createExecutorService({ client: unusedClient });
  });

  it("addLiquidity", async () => {
    const result = await executor.addLiquidity(makePlan(), makePm());
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/MoveAbort/);
    expect(result.digest).toBe("");
  });

  it("removeLiquidity", async () => {
    const result = await executor.removeLiquidity(makePlan(), makePm());
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/MoveAbort/);
  });

  it("collectAndTransferFees", async () => {
    const result = await executor.collectAndTransferFees("pm1", makePm());
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/MoveAbort/);
  });
});
