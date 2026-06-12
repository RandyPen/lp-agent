/**
 * Tests for the unified-rebalance PTB shape. We don't sign or submit anything
 * — just exercise the builder against deterministic inputs and verify the
 * Transaction has the right command count + description shape.
 *
 * Environment: AGENT_PRIVATE_KEY needs to be a real ED25519 suiprivkey1 for
 * `loadConfig`. We set a known-test value in beforeAll.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { resetConfigCacheForTests } from "../src/config.ts";
import { resetKeypairCacheForTests } from "../src/sui/keypair.ts";
import type { PMState, RebalancePlan } from "../src/domain/types.ts";
import { emptyLendingState } from "../src/sui/lending/types.ts";

// A locally generated Ed25519 keypair. Not used to sign anything here; we
// just need loadConfig + getAgentAddress to succeed at build time. Regenerate
// with: `bun -e "import('@mysten/sui/keypairs/ed25519').then(m =>
//        console.log(m.Ed25519Keypair.generate().getSecretKey()))"`.
const TEST_PRIVKEY =
  "suiprivkey1qr3twlseqm4qj5sr7mqhz3yyx7wrluu3qn39nj6jxpsxufe46mul574lteq";

const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const USDC =
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";

function emptyPlan(pmId: string): RebalancePlan {
  return {
    pmId,
    removeShares: new Map(),
    addAmountA: 0n,
    addAmountB: 0n,
    addBins: [],
    addAmountsA: [],
    addAmountsB: [],
    collectFees: false,
    reason: "test-empty",
  };
}

function basicPm(): PMState {
  return {
    pmId: "0xpm",
    owner: "0xowner",
    poolId: "0xpool",
    coinTypeA: SUI,
    coinTypeB: USDC,
    balance: { a: 0n, b: 0n },
    feeBag: { a: 0n, b: 0n },
    positionBins: [],
    lending: emptyLendingState(),
  };
}

const origEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  origEnv.AGENT_PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY;
  origEnv.SUI_USDC_POOL_ID = process.env.SUI_USDC_POOL_ID;
  origEnv.LENDING_ENABLED = process.env.LENDING_ENABLED;
  origEnv.EXPECTED_AGENT_ADDRESS = process.env.EXPECTED_AGENT_ADDRESS;
  origEnv.IDENTITY_FILES_DISABLED = process.env.IDENTITY_FILES_DISABLED;
  process.env.AGENT_PRIVATE_KEY = TEST_PRIVKEY;
  process.env.SUI_USDC_POOL_ID = "0xpool";
  // Derive the expected agent address from the test private key — loadConfig
  // requires EXPECTED_AGENT_ADDRESS to be set and well-formed.
  const { secretKey } = decodeSuiPrivateKey(TEST_PRIVKEY);
  process.env.EXPECTED_AGENT_ADDRESS = Ed25519Keypair.fromSecretKey(secretKey).toSuiAddress();
  process.env.IDENTITY_FILES_DISABLED = "true";
  // Disable lending so Scallop/Kai adapters aren't reached during tests.
  process.env.LENDING_ENABLED = "false";
  resetConfigCacheForTests();
  resetKeypairCacheForTests();
});

afterAll(() => {
  if (origEnv.AGENT_PRIVATE_KEY !== undefined) {
    process.env.AGENT_PRIVATE_KEY = origEnv.AGENT_PRIVATE_KEY;
  } else {
    delete process.env.AGENT_PRIVATE_KEY;
  }
  if (origEnv.SUI_USDC_POOL_ID !== undefined) {
    process.env.SUI_USDC_POOL_ID = origEnv.SUI_USDC_POOL_ID;
  } else {
    delete process.env.SUI_USDC_POOL_ID;
  }
  if (origEnv.LENDING_ENABLED !== undefined) {
    process.env.LENDING_ENABLED = origEnv.LENDING_ENABLED;
  } else {
    delete process.env.LENDING_ENABLED;
  }
  if (origEnv.EXPECTED_AGENT_ADDRESS !== undefined) {
    process.env.EXPECTED_AGENT_ADDRESS = origEnv.EXPECTED_AGENT_ADDRESS;
  } else {
    delete process.env.EXPECTED_AGENT_ADDRESS;
  }
  if (origEnv.IDENTITY_FILES_DISABLED !== undefined) {
    process.env.IDENTITY_FILES_DISABLED = origEnv.IDENTITY_FILES_DISABLED;
  } else {
    delete process.env.IDENTITY_FILES_DISABLED;
  }
  resetConfigCacheForTests();
  resetKeypairCacheForTests();
});

describe("buildUnifiedRebalanceTx", () => {
  it("emits zero commands for a fully-empty plan", async () => {
    const { buildUnifiedRebalanceTx } = await import("../src/sui/cdpm/txUnified.ts");
    const out = await buildUnifiedRebalanceTx({
      plan: emptyPlan("0xpm"),
      pm: basicPm(),
      lendingDecisions: [],
    });
    expect(out.commandCount).toBe(0);
    expect(out.description).toContain("unified[0]");
  });

  it("emits a single add_liquidity command for a pure-add plan", async () => {
    const { buildUnifiedRebalanceTx } = await import("../src/sui/cdpm/txUnified.ts");
    const plan: RebalancePlan = {
      pmId: "0xpm",
      removeShares: new Map(),
      addAmountA: 1_000_000n,
      addAmountB: 500_000n,
      addBins: [-5990, -5989, -5988],
      addAmountsA: [400_000n, 300_000n, 300_000n],
      addAmountsB: [100_000n, 200_000n, 200_000n],
      collectFees: false,
      reason: "test",
    };
    const out = await buildUnifiedRebalanceTx({
      plan,
      pm: basicPm(),
      lendingDecisions: [],
    });
    expect(out.commandCount).toBe(1);
    expect(out.description).toContain("add[3]");
  });

  it("includes collect_fee + remove + transfer_fee + add when the plan is full", async () => {
    const { buildUnifiedRebalanceTx } = await import("../src/sui/cdpm/txUnified.ts");
    const pm = basicPm();
    pm.feeBag = { a: 1_000n, b: 2_000n };
    pm.balance = { a: 100_000n, b: 200_000n };
    const plan: RebalancePlan = {
      pmId: "0xpm",
      removeShares: new Map([[-5990, 1_000_000_000_000_000n]]),
      addAmountA: 50_000n,
      addAmountB: 50_000n,
      addBins: [-5989],
      addAmountsA: [50_000n],
      addAmountsB: [50_000n],
      collectFees: true,
      reason: "test",
    };
    const out = await buildUnifiedRebalanceTx({
      plan,
      pm,
      lendingDecisions: [],
    });
    // collect_fee + remove + transfer_fee[A] + transfer_fee[B] + add = 5 commands
    expect(out.commandCount).toBe(5);
    expect(out.description).toContain("collect_fee");
    expect(out.description).toContain("remove[1]");
    expect(out.description).toContain("transfer_fee[A=1000]");
    expect(out.description).toContain("transfer_fee[B=2000]");
    expect(out.description).toContain("add[1]");
  });

  it("rejects negative add amounts at build time", async () => {
    const { buildUnifiedRebalanceTx } = await import("../src/sui/cdpm/txUnified.ts");
    const plan: RebalancePlan = {
      pmId: "0xpm",
      removeShares: new Map(),
      // addAmountA positive so the addLiquidity branch runs and validation
      // catches the negative per-bin entry.
      addAmountA: 1_000n,
      addAmountB: 0n,
      addBins: [0, 1],
      addAmountsA: [-1n, 1_001n],
      addAmountsB: [0n, 0n],
      collectFees: false,
      reason: "test",
    };
    await expect(
      buildUnifiedRebalanceTx({
        plan,
        pm: basicPm(),
        lendingDecisions: [],
      }),
    ).rejects.toThrow();
  });
});
