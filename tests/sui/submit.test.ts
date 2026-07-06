/**
 * tests/sui/submit.test.ts — submitWithRetry idempotent-retry semantics.
 *
 * The Transaction / Signer / client are faked at the seam submitWithRetry
 * actually touches (build → sign → execute / lookup), so these tests pin the
 * retry CONTRACT: build+sign exactly once, digest-check before any resubmit,
 * identical bytes on resubmit, no retry on execution-level failures.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import type { Transaction } from "@mysten/sui/transactions";
import type { Signer } from "@mysten/sui/cryptography";
import { isTransientRpcError, submitWithRetry } from "../../src/sui/submit.ts";
import type { SuiClient } from "../../src/sui/client.ts";
import { resetConfigCacheForTests } from "../../src/config.ts";

// Minimal env so loadConfig() inside submitWithRetry resolves.
const REQUIRED_ENV: Record<string, string> = {
  AGENT_PRIVATE_KEY: "suiprivkey1qr3twlseqm4qj5sr7mqhz3yyx7wrluu3qn39nj6jxpsxufe46mul574lteq",
  SUI_USDC_POOL_ID: "0xpool",
  EXPECTED_AGENT_ADDRESS:
    "0xf3f8feeba6b94376511dfc38d51ea3f5d2f3d1b70725fa0f50e5253a66d0d0b9",
  IDENTITY_FILES_DISABLED: "true",
  LENDING_ENABLED: "false",
};
const origEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const [k, v] of Object.entries(REQUIRED_ENV)) {
    origEnv[k] = process.env[k];
    process.env[k] = v;
  }
  resetConfigCacheForTests();
});

afterAll(() => {
  for (const k of Object.keys(REQUIRED_ENV)) {
    if (origEnv[k] !== undefined) process.env[k] = origEnv[k];
    else delete process.env[k];
  }
  resetConfigCacheForTests();
});

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const FAKE_BYTES = new Uint8Array([1, 2, 3, 4, 5]);

function makeFakeTx(): { tx: Transaction; buildCalls: () => number } {
  let builds = 0;
  const tx = {
    build: async () => {
      builds++;
      return FAKE_BYTES;
    },
  } as unknown as Transaction;
  return { tx, buildCalls: () => builds };
}

function makeFakeSigner(): { signer: Signer; signCalls: () => number } {
  let signs = 0;
  const signer = {
    signTransaction: async (bytes: Uint8Array) => {
      signs++;
      return { signature: "fake-sig", bytes: Buffer.from(bytes).toString("base64") };
    },
  } as unknown as Signer;
  return { signer, signCalls: () => signs };
}

interface FakeClientScript {
  /** Outcomes for successive executeTransactionBlock calls. */
  execOutcomes: Array<{ ok?: { digest: string } } | { err: string }>;
  /** Outcome for getTransactionBlock: found result or throw. */
  lookup?: { found?: { digest: string }; throws?: string };
}

function makeFakeClient(script: FakeClientScript) {
  let execCalls = 0;
  let lookupCalls = 0;
  const execBytes: unknown[] = [];
  const client = {
    executeTransactionBlock: async (args: { transactionBlock: unknown }) => {
      const outcome = script.execOutcomes[execCalls];
      execCalls++;
      execBytes.push(args.transactionBlock);
      if (!outcome) throw new Error("fake client: no scripted outcome left");
      if ("err" in outcome) throw new Error(outcome.err);
      return outcome.ok;
    },
    getTransactionBlock: async () => {
      lookupCalls++;
      if (script.lookup?.found) return script.lookup.found;
      throw new Error(script.lookup?.throws ?? "Could not find the referenced transaction");
    },
  } as unknown as SuiClient;
  return {
    client,
    execCalls: () => execCalls,
    lookupCalls: () => lookupCalls,
    execBytes: () => execBytes,
  };
}

const noSleep = async () => {};

// ---------------------------------------------------------------------------
// isTransientRpcError
// ---------------------------------------------------------------------------

describe("isTransientRpcError", () => {
  it("network / gateway / rate-limit errors are transient", () => {
    expect(isTransientRpcError(new Error("fetch failed"))).toBe(true);
    expect(isTransientRpcError(new Error("HTTP 503 Service Unavailable"))).toBe(true);
    expect(isTransientRpcError(new Error("socket hang up"))).toBe(true);
    expect(isTransientRpcError(new Error("429 Too Many Requests"))).toBe(true);
    expect(isTransientRpcError(new Error("request timeout"))).toBe(true);
  });

  it("execution-level failures are NEVER transient", () => {
    expect(isTransientRpcError(new Error("MoveAbort in module cdpm, code 7"))).toBe(false);
    expect(isTransientRpcError(new Error("InsufficientGas"))).toBe(false);
    expect(isTransientRpcError(new Error("CommandArgumentError"))).toBe(false);
  });

  it("execution failure wins even when the message also matches a transport pattern", () => {
    expect(isTransientRpcError(new Error("network delivered: MoveAbort code 3"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// submitWithRetry
// ---------------------------------------------------------------------------

describe("submitWithRetry", () => {
  it("happy path: one build, one sign, one submit", async () => {
    const { tx, buildCalls } = makeFakeTx();
    const { signer, signCalls } = makeFakeSigner();
    const fake = makeFakeClient({ execOutcomes: [{ ok: { digest: "0xd1" } }] });

    const result = await submitWithRetry(fake.client, tx, signer, { sleep: noSleep });
    expect(result.digest).toBe("0xd1");
    expect(buildCalls()).toBe(1);
    expect(signCalls()).toBe(1);
    expect(fake.execCalls()).toBe(1);
    expect(fake.lookupCalls()).toBe(0);
  });

  it("transient error → digest lookup finds the landed tx → success WITHOUT resubmit", async () => {
    const { tx } = makeFakeTx();
    const { signer } = makeFakeSigner();
    const fake = makeFakeClient({
      execOutcomes: [{ err: "fetch failed" }],
      lookup: { found: { digest: "0xlanded" } },
    });

    const result = await submitWithRetry(fake.client, tx, signer, {
      attempts: 1,
      sleep: noSleep,
    });
    expect(result.digest).toBe("0xlanded");
    expect(fake.execCalls()).toBe(1); // never resubmitted
    expect(fake.lookupCalls()).toBe(1);
  });

  it("transient error → not found on-chain → resubmits the IDENTICAL bytes", async () => {
    const { tx, buildCalls } = makeFakeTx();
    const { signer, signCalls } = makeFakeSigner();
    const fake = makeFakeClient({
      execOutcomes: [{ err: "ECONNRESET" }, { ok: { digest: "0xd2" } }],
    });

    const result = await submitWithRetry(fake.client, tx, signer, {
      attempts: 1,
      sleep: noSleep,
    });
    expect(result.digest).toBe("0xd2");
    expect(fake.execCalls()).toBe(2);
    // Build + sign happened ONCE — the retry reuses the same signed bytes
    // (a rebuild would mint a new digest and risk double execution).
    expect(buildCalls()).toBe(1);
    expect(signCalls()).toBe(1);
    expect(fake.execBytes()[0]).toBe(fake.execBytes()[1]);
  });

  it("non-transient error throws immediately without retry or lookup", async () => {
    const { tx } = makeFakeTx();
    const { signer } = makeFakeSigner();
    const fake = makeFakeClient({
      execOutcomes: [{ err: "MoveAbort in cdpm::cdpm, code 5" }],
    });

    await expect(
      submitWithRetry(fake.client, tx, signer, { attempts: 3, sleep: noSleep }),
    ).rejects.toThrow(/MoveAbort/);
    expect(fake.execCalls()).toBe(1);
    expect(fake.lookupCalls()).toBe(0);
  });

  it("exhausted retries rethrow the last transient error", async () => {
    const { tx } = makeFakeTx();
    const { signer } = makeFakeSigner();
    const fake = makeFakeClient({
      execOutcomes: [{ err: "timeout" }, { err: "timeout" }],
    });

    await expect(
      submitWithRetry(fake.client, tx, signer, { attempts: 1, sleep: noSleep }),
    ).rejects.toThrow(/timeout/);
    expect(fake.execCalls()).toBe(2);
  });
});
