/**
 * tests/sui/submit.test.ts — submitWithRetry idempotent-retry semantics.
 *
 * The Transaction / Signer / client are faked at the seam submitWithRetry
 * actually touches (build → sign → execute / lookup), so these tests pin the
 * retry CONTRACT: build+sign exactly once, digest-check before any resubmit,
 * identical bytes on resubmit, no retry on execution-level failures,
 * on-chain abort detection (a committed-but-failed tx is never reported as
 * success, and is never retried), and balance-paid gas (no owned gas-coin
 * object is ever selected, and an under-funded address balance fails loud
 * instead of silently falling back to coin-object gas selection).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { TransactionDataBuilder } from "@mysten/sui/transactions";
import type { Transaction } from "@mysten/sui/transactions";
import type { Signer } from "@mysten/sui/cryptography";
import {
  isTransientRpcError,
  submitWithRetry,
  OnChainExecutionError,
  InsufficientAddressBalanceError,
  MIN_ADDRESS_BALANCE_MIST,
  resetAddressBalanceCheckCacheForTests,
} from "../../src/sui/submit.ts";
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

beforeEach(() => {
  // The address-balance pre-flight check is cached per-address for 60s at
  // the module level — reset it so tests don't leak state into each other.
  resetAddressBalanceCheckCacheForTests();
});

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const FAKE_BYTES = new Uint8Array([1, 2, 3, 4, 5]);
// submitWithRetry identifies the tx by the digest it computes locally from
// the signed bytes (used for every lookup/log/error) — NOT by whatever
// `digest` field a fake RPC response happens to echo back.
const FAKE_DIGEST = TransactionDataBuilder.getDigestFromBytes(FAKE_BYTES);

/** Successful effects block — the shape real RPC responses carry. */
const SUCCESS_EFFECTS = { status: { status: "success" } };
/** Committed-but-aborted effects block (Move abort, slippage guard, etc.). */
function abortEffects(error = "MoveAbort(cdpm, 7)") {
  return { status: { status: "failure", error } };
}

/** Plenty of address balance — well above MIN_ADDRESS_BALANCE_MIST. */
const AMPLE_ADDRESS_BALANCE_MIST = (MIN_ADDRESS_BALANCE_MIST * 10n).toString();

function makeFakeTx(): { tx: Transaction; buildCalls: () => number; gasPaymentCalls: () => unknown[][] } {
  let builds = 0;
  const gasPaymentCalls: unknown[][] = [];
  const tx = {
    setGasPayment: (payment: unknown[]) => {
      gasPaymentCalls.push(payment);
    },
    build: async () => {
      builds++;
      return FAKE_BYTES;
    },
  } as unknown as Transaction;
  return { tx, buildCalls: () => builds, gasPaymentCalls: () => gasPaymentCalls };
}

function makeFakeSigner(address = "0xagent"): {
  signer: Signer;
  signCalls: () => number;
} {
  let signs = 0;
  const signer = {
    signTransaction: async (bytes: Uint8Array) => {
      signs++;
      return { signature: "fake-sig", bytes: Buffer.from(bytes).toString("base64") };
    },
    toSuiAddress: () => address,
  } as unknown as Signer;
  return { signer, signCalls: () => signs };
}

interface FakeClientScript {
  /** Outcomes for successive executeTransactionBlock calls. */
  execOutcomes: Array<{ ok: { digest: string; effects?: unknown } } | { err: string }>;
  /** Outcome for getTransactionBlock: found result or throw. */
  lookup?: { found?: { digest: string; effects?: unknown }; throws?: string };
  /** `core.getBalance` response override; defaults to ample balance. */
  addressBalanceMist?: string | null;
}

function makeFakeClient(script: FakeClientScript) {
  let execCalls = 0;
  let lookupCalls = 0;
  let balanceCalls = 0;
  const execBytes: unknown[] = [];
  const client = {
    core: {
      getBalance: async () => {
        balanceCalls++;
        const addressBalance =
          script.addressBalanceMist === undefined ? AMPLE_ADDRESS_BALANCE_MIST : script.addressBalanceMist;
        return { balance: { addressBalance } };
      },
    },
    executeTransactionBlock: async (args: { transactionBlock: unknown }) => {
      const outcome = script.execOutcomes[execCalls];
      execCalls++;
      execBytes.push(args.transactionBlock);
      if (!outcome) throw new Error("fake client: no scripted outcome left");
      if ("err" in outcome) throw new Error(outcome.err);
      return { effects: SUCCESS_EFFECTS, ...outcome.ok };
    },
    getTransactionBlock: async () => {
      lookupCalls++;
      if (script.lookup?.found) return { effects: SUCCESS_EFFECTS, ...script.lookup.found };
      throw new Error(script.lookup?.throws ?? "Could not find the referenced transaction");
    },
  } as unknown as SuiClient;
  return {
    client,
    execCalls: () => execCalls,
    lookupCalls: () => lookupCalls,
    balanceCalls: () => balanceCalls,
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

  // -------------------------------------------------------------------------
  // Fix 1: committed-but-aborted transactions must never be reported success.
  // -------------------------------------------------------------------------

  it("executeTransactionBlock returns a committed abort → throws OnChainExecutionError, never retried", async () => {
    const { tx } = makeFakeTx();
    const { signer } = makeFakeSigner();
    const fake = makeFakeClient({
      execOutcomes: [{ ok: { digest: "0xaborted", effects: abortEffects("MoveAbort(cdpm, 7)") } }],
    });

    const err = await submitWithRetry(fake.client, tx, signer, { attempts: 3, sleep: noSleep }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(OnChainExecutionError);
    expect((err as OnChainExecutionError).digest).toBe(FAKE_DIGEST);
    expect((err as OnChainExecutionError).effectsError).toMatch(/MoveAbort/);
    // Committed abort — must not resubmit.
    expect(fake.execCalls()).toBe(1);
    expect(fake.lookupCalls()).toBe(0);
  });

  it("digest-lookup path finds a committed abort → throws, does not resubmit or mask as not-found", async () => {
    const { tx } = makeFakeTx();
    const { signer } = makeFakeSigner();
    const fake = makeFakeClient({
      execOutcomes: [{ err: "fetch failed" }],
      lookup: { found: { digest: "0xaborted", effects: abortEffects("InvalidInstruction") } },
    });

    const err = await submitWithRetry(fake.client, tx, signer, { attempts: 2, sleep: noSleep }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(OnChainExecutionError);
    expect((err as OnChainExecutionError).digest).toBe(FAKE_DIGEST);
    // Found the abort on the very first lookup — never resubmitted past the
    // original attempt.
    expect(fake.execCalls()).toBe(1);
    expect(fake.lookupCalls()).toBe(1);
  });

  it("missing effects.status is treated as a fail-loud error, not a silent success", async () => {
    const { tx } = makeFakeTx();
    const { signer } = makeFakeSigner();
    const client = {
      core: { getBalance: async () => ({ balance: { addressBalance: AMPLE_ADDRESS_BALANCE_MIST } }) },
      executeTransactionBlock: async () => ({ digest: "0xnoeffects" }), // no `effects` at all
      getTransactionBlock: async () => {
        throw new Error("unused");
      },
    } as unknown as SuiClient;

    const err = await submitWithRetry(client, tx, signer, { attempts: 0, sleep: noSleep }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(OnChainExecutionError);
    expect((err as OnChainExecutionError).effectsError).toMatch(/missing effects/i);
  });

  // -------------------------------------------------------------------------
  // Fix 2: the final exhausted-retry attempt gets one last digest recheck.
  // -------------------------------------------------------------------------

  it("final attempt lands but its response is lost → recovered by the post-loop digest check", async () => {
    const { tx } = makeFakeTx();
    const { signer } = makeFakeSigner();
    let execCalls = 0;
    let lookupCalls = 0;
    const client = {
      core: { getBalance: async () => ({ balance: { addressBalance: AMPLE_ADDRESS_BALANCE_MIST } }) },
      executeTransactionBlock: async () => {
        execCalls++;
        throw new Error("timeout");
      },
      getTransactionBlock: async () => {
        lookupCalls++;
        // The in-loop lookup (which runs BEFORE the final attempt, checking
        // whether the PREVIOUS attempt landed) still sees nothing — only the
        // post-loop check (after the final attempt's own transient error)
        // discovers that the last attempt actually landed.
        if (lookupCalls < 2) throw new Error("not found");
        return { digest: "0xfinal", effects: SUCCESS_EFFECTS };
      },
    } as unknown as SuiClient;

    const result = await submitWithRetry(client, tx, signer, { attempts: 1, sleep: noSleep });
    expect(result.digest).toBe("0xfinal");
    expect(execCalls).toBe(2);
    expect(lookupCalls).toBe(2);
  });

  it("final digest check also finds a committed abort → throws instead of silently failing as transient", async () => {
    const { tx } = makeFakeTx();
    const { signer } = makeFakeSigner();
    const fake = makeFakeClient({
      execOutcomes: [{ err: "timeout" }],
      lookup: { found: { digest: "0xfinal", effects: abortEffects("MoveAbort(cdpm, 2)") } },
    });

    const err = await submitWithRetry(fake.client, tx, signer, { attempts: 0, sleep: noSleep }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(OnChainExecutionError);
  });

  // -------------------------------------------------------------------------
  // Fix 3 (revised): gas is paid from the signer's address balance, not an
  // owned gas-coin object, eliminating gas-object contention. An
  // under-funded address balance fails loud rather than silently falling
  // back to owned-coin gas selection.
  // -------------------------------------------------------------------------

  it("forces balance-paid gas: setGasPayment([]) is called before build", async () => {
    const { tx, gasPaymentCalls, buildCalls } = makeFakeTx();
    const { signer } = makeFakeSigner();
    const fake = makeFakeClient({ execOutcomes: [{ ok: { digest: "0xd1" } }] });

    await submitWithRetry(fake.client, tx, signer, { sleep: noSleep });
    expect(gasPaymentCalls()).toEqual([[]]);
    // setGasPayment must happen before build (build must never be called
    // with the SDK's default owned-coin gas resolution still enabled).
    expect(buildCalls()).toBe(1);
  });

  it("insufficient address balance throws InsufficientAddressBalanceError before build/sign/execute", async () => {
    const { tx, buildCalls } = makeFakeTx();
    const { signer, signCalls } = makeFakeSigner();
    const fake = makeFakeClient({
      execOutcomes: [{ ok: { digest: "0xd1" } }],
      addressBalanceMist: (MIN_ADDRESS_BALANCE_MIST - 1n).toString(),
    });

    const err = await submitWithRetry(fake.client, tx, signer, { sleep: noSleep }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InsufficientAddressBalanceError);
    expect((err as InsufficientAddressBalanceError).addressBalanceMist).toBe(MIN_ADDRESS_BALANCE_MIST - 1n);
    expect((err as Error).message).toMatch(/fund-address-balance\.ts/);
    // Fail loud BEFORE ever touching build/sign/execute — never silently
    // falls back to owned-coin gas selection.
    expect(buildCalls()).toBe(0);
    expect(signCalls()).toBe(0);
    expect(fake.execCalls()).toBe(0);
  });

  it("missing addressBalance field fails loud instead of assuming sufficiency", async () => {
    const { tx } = makeFakeTx();
    const { signer } = makeFakeSigner();
    const fake = makeFakeClient({ execOutcomes: [{ ok: { digest: "0xd1" } }], addressBalanceMist: null });

    const err = await submitWithRetry(fake.client, tx, signer, { sleep: noSleep }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InsufficientAddressBalanceError);
    expect((err as InsufficientAddressBalanceError).addressBalanceMist).toBeNull();
  });

  it("caches a passing balance check — a second submit within the TTL doesn't re-query", async () => {
    const { signer } = makeFakeSigner();
    const fake = makeFakeClient({
      execOutcomes: [{ ok: { digest: "0xd1" } }, { ok: { digest: "0xd2" } }],
    });

    const { tx: tx1 } = makeFakeTx();
    await submitWithRetry(fake.client, tx1, signer, { sleep: noSleep });
    expect(fake.balanceCalls()).toBe(1);

    const { tx: tx2 } = makeFakeTx();
    await submitWithRetry(fake.client, tx2, signer, { sleep: noSleep });
    expect(fake.balanceCalls()).toBe(1); // served from the 60s cache
  });

  it("skipBalanceCheck bypasses the pre-flight check entirely", async () => {
    const { tx } = makeFakeTx();
    const { signer } = makeFakeSigner();
    const fake = makeFakeClient({
      execOutcomes: [{ ok: { digest: "0xd1" } }],
      addressBalanceMist: "0",
    });

    const result = await submitWithRetry(fake.client, tx, signer, { sleep: noSleep, skipBalanceCheck: true });
    expect(result.digest).toBe("0xd1");
    expect(fake.balanceCalls()).toBe(0);
  });
});
