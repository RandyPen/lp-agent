/**
 * Tests for src/treasury/operator.ts and src/treasury/opsStore.ts
 *
 * All tests use:
 *   - An in-memory SQLite DB (per-test, via freshDb helper)
 *   - A fake OperatorClient that records submitted transactions and serves
 *     controllable coin balances without network calls
 *   - Injected fake KeypairProvider — no .env, no mnemonics, no mock.module
 *
 * The fake keypair provider returns predictable addresses; the fake client
 * maps those addresses to the configured coin balances.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, resetDbCacheForTests } from "../../src/db/client.ts";
import {
  recordOp,
  markOpResult,
  listOps,
  getOpById,
  newOpId,
} from "../../src/treasury/opsStore.ts";
import type { OperatorClient, KeypairProvider, OperatorKeypair } from "../../src/treasury/operator.ts";
import {
  sweepDepositAddress,
  sweepAll,
  refundUser,
  SUI_COIN_TYPE,
  GAS_RESERVE_MIST,
} from "../../src/treasury/operator.ts";
import { isGaslessEligible } from "../../src/treasury/gasless.ts";
import {
  findUserBySuiAddress,
  getAddressBalance,
  registerUserTx,
  upsertCreditRate,
  upsertAddressBalance,
} from "../../src/treasury/store.ts";
import { canonicalType } from "../../src/sui/lending/typeNorm.ts";

// ---- fake address constants -----------------------------------------------

const FAKE_DEPOSIT_ADDR_1 = "0x" + "aa".repeat(32);
const FAKE_DEPOSIT_ADDR_2 = "0x" + "bb".repeat(32);
const FAKE_MASTER_ADDR = "0x" + "cc".repeat(32);
const FAKE_USER1_ADDR = "0x" + "dd".repeat(32);
const FAKE_USER2_ADDR = "0x" + "ee".repeat(32);

// ---- fake keypair builder -------------------------------------------------

function makeFakeKeypair(address: string): OperatorKeypair {
  return { toSuiAddress: () => address };
}

function makeFakeKpProvider(): KeypairProvider {
  return {
    getUserDepositKeypair: (index: number): OperatorKeypair => {
      if (index === 1) return makeFakeKeypair(FAKE_DEPOSIT_ADDR_1);
      if (index === 2) return makeFakeKeypair(FAKE_DEPOSIT_ADDR_2);
      throw new Error(`test: unexpected derivation index ${index}`);
    },
    getMasterAddress: (): string => FAKE_MASTER_ADDR,
  };
}

const FAKE_KP = makeFakeKpProvider();

// ---- DB setup ------------------------------------------------------------

let tmpDir: string;

function freshDb(): void {
  resetDbCacheForTests();
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDir = mkdtempSync(join(tmpdir(), "treasury-operator-"));
  openDb(join(tmpDir, "test.db"));
}

beforeEach(() => freshDb());
afterAll(() => {
  resetDbCacheForTests();
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ---- fake SuiClient builder ----------------------------------------------

const SUI_TYPE = canonicalType(SUI_COIN_TYPE);
const USDC_TYPE = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
// A non-gasless coin type for tests that exercise the gas-required path.
// This must NOT be in GASLESS_STABLECOINS — it's a fake arbitrary coin.
const FAKE_NONGAS_COIN = "0x1111111111111111111111111111111111111111111111111111111111111111::fakecoin::FAKECOIN";

interface TxRecord {
  from: string;
  /** Placeholder — the field exists for historical reasons but no test reads it.
   *  We no longer call JSON.stringify(transaction) because the gasless PTB now
   *  uses a CoinWithBalance intent that requires an async client to resolve,
   *  making synchronous JSON.stringify impossible for gasless transactions. */
  commands: string;
}

interface CoinEntry {
  coinObjectId: string;
  version: string;
  digest: string;
  balance: string;
}

function makeFakeClient(opts: {
  /** Map from "address::coinType" → array of coin objects. */
  coins: Record<string, CoinEntry[]>;
  /** When true, signAndExecuteTransaction returns failure status. */
  failTx?: boolean;
  /** When defined, override the digest returned. */
  digest?: string;
}): {
  client: OperatorClient;
  txSubmissions: TxRecord[];
  setCoins(addr: string, coinType: string, coins: CoinEntry[]): void;
} {
  const txSubmissions: TxRecord[] = [];

  const client: OperatorClient = {
    async getCoins({ owner, coinType, cursor: _cursor, limit: _limit }) {
      const key = `${owner}::${canonicalType(coinType)}`;
      const data = opts.coins[key] ?? [];
      return { data, hasNextPage: false, nextCursor: null };
    },
    async signAndExecuteTransaction({ transaction, signer }) {
      // Do NOT call JSON.stringify(transaction) — gasless PTBs use a
      // CoinWithBalance intent that needs an async client to resolve, making
      // synchronous stringification throw. We capture a static label instead.
      txSubmissions.push({
        from: signer.toSuiAddress(),
        commands: `[Transaction@${Date.now()}]`,
      });
      const digest = opts.digest ?? `fake_digest_${Date.now()}`;
      if (opts.failTx) {
        return {
          digest,
          effects: { status: { status: "failure", error: "simulated failure" } },
        };
      }
      return {
        digest,
        effects: { status: { status: "success" } },
      };
    },
  };

  return {
    client,
    txSubmissions,
    setCoins(addr: string, coinType: string, coins: CoinEntry[]) {
      opts.coins[`${addr}::${canonicalType(coinType)}`] = coins;
    },
  };
}

// ---- helpers for consistent coin entries ---------------------------------

function suiCoins(
  totalMist: bigint,
  objectId = "0x" + "01".repeat(32),
): CoinEntry[] {
  return [
    {
      coinObjectId: objectId,
      version: "1",
      digest: "fakedigest",
      balance: totalMist.toString(),
    },
  ];
}

function usdcCoins(
  totalAtomic: bigint,
  objectId = "0x" + "02".repeat(32),
): CoinEntry[] {
  return [
    {
      coinObjectId: objectId,
      version: "1",
      digest: "fakedigest2",
      balance: totalAtomic.toString(),
    },
  ];
}

function fakeNonGasCoins(
  totalAtomic: bigint,
  objectId = "0x" + "03".repeat(32),
): CoinEntry[] {
  return [
    {
      coinObjectId: objectId,
      version: "1",
      digest: "fakedigest3",
      balance: totalAtomic.toString(),
    },
  ];
}

// ---- seed DB helpers -----------------------------------------------------

function seedUser1(): void {
  registerUserTx(FAKE_USER1_ADDR, () => FAKE_DEPOSIT_ADDR_1);
  upsertCreditRate({
    coinType: SUI_TYPE,
    rateNum: 25n,
    rateDen: 100_000_000n,
  });
}

function seedUser2(): void {
  registerUserTx(FAKE_USER2_ADDR, () => FAKE_DEPOSIT_ADDR_2);
}

// ==========================================================================
// opsStore tests
// ==========================================================================

describe("opsStore — recordOp", () => {
  it("inserts a pending row and returns a string id", () => {
    seedUser1();
    const id = recordOp({
      opKind: "sweep",
      fromAddress: FAKE_DEPOSIT_ADDR_1,
      toAddress: FAKE_MASTER_ADDR,
      coinTypeIn: SUI_TYPE,
      amountIn: 1_000_000n,
      initiatedBy: "test",
    });
    expect(typeof id).toBe("string");
    expect(id.startsWith("op_")).toBe(true);

    const op = getOpById(id);
    expect(op).not.toBeNull();
    expect(op!.status).toBe("pending");
    expect(op!.opKind).toBe("sweep");
    expect(op!.amountIn).toBe(1_000_000n);
    expect(op!.toAddress).toBe(FAKE_MASTER_ADDR);
  });

  it("newOpId generates string ids with op_ prefix", () => {
    const id = newOpId();
    expect(id.startsWith("op_")).toBe(true);
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(5);
  });
});

describe("opsStore — markOpResult", () => {
  it("transitions pending → succeeded with digest", () => {
    seedUser1();
    const id = recordOp({
      opKind: "sweep",
      fromAddress: FAKE_DEPOSIT_ADDR_1,
      toAddress: FAKE_MASTER_ADDR,
      coinTypeIn: SUI_TYPE,
      amountIn: 500n,
      initiatedBy: "test",
    });
    markOpResult(id, { status: "succeeded", digest: "0xdig" });
    const op = getOpById(id);
    expect(op!.status).toBe("succeeded");
    expect(op!.digest).toBe("0xdig");
    expect(op!.error).toBeNull();
  });

  it("transitions pending → failed with error message", () => {
    seedUser1();
    const id = recordOp({
      opKind: "sweep",
      fromAddress: FAKE_DEPOSIT_ADDR_1,
      toAddress: null,
      coinTypeIn: SUI_TYPE,
      amountIn: 1n,
      initiatedBy: "test",
    });
    markOpResult(id, { status: "failed", error: "rpc timeout" });
    const op = getOpById(id);
    expect(op!.status).toBe("failed");
    expect(op!.error).toBe("rpc timeout");
  });

  it("is idempotent — already-terminal row is not modified", () => {
    seedUser1();
    const id = recordOp({
      opKind: "sweep",
      fromAddress: FAKE_DEPOSIT_ADDR_1,
      toAddress: null,
      coinTypeIn: SUI_TYPE,
      amountIn: 1n,
      initiatedBy: "test",
    });
    markOpResult(id, { status: "succeeded", digest: "dig1" });
    // Second call should be ignored (WHERE status='pending' clause).
    markOpResult(id, { status: "failed", error: "overwrite attempt" });
    const op = getOpById(id);
    expect(op!.status).toBe("succeeded");
    expect(op!.digest).toBe("dig1");
  });
});

describe("opsStore — listOps", () => {
  it("returns all rows ordered newest first", () => {
    seedUser1();
    const id1 = recordOp({
      opKind: "sweep",
      fromAddress: FAKE_DEPOSIT_ADDR_1,
      toAddress: null,
      coinTypeIn: SUI_TYPE,
      amountIn: 1n,
      nowMs: 1000,
      initiatedBy: "test",
    });
    const id2 = recordOp({
      opKind: "transfer",
      fromAddress: FAKE_DEPOSIT_ADDR_1,
      toAddress: "0xrecipient",
      coinTypeIn: SUI_TYPE,
      amountIn: 2n,
      nowMs: 2000,
      initiatedBy: "test",
    });
    const ops = listOps();
    expect(ops.length).toBe(2);
    // Newest first.
    expect(ops[0]!.id).toBe(id2);
    expect(ops[1]!.id).toBe(id1);
  });

  it("filters by opKind", () => {
    seedUser1();
    recordOp({ opKind: "sweep", fromAddress: FAKE_DEPOSIT_ADDR_1, toAddress: null, coinTypeIn: SUI_TYPE, amountIn: 1n, initiatedBy: "t" });
    recordOp({ opKind: "transfer", fromAddress: FAKE_DEPOSIT_ADDR_1, toAddress: null, coinTypeIn: SUI_TYPE, amountIn: 2n, initiatedBy: "t" });
    expect(listOps({ opKind: "sweep" }).length).toBe(1);
    expect(listOps({ opKind: "transfer" }).length).toBe(1);
  });

  it("filters by status", () => {
    seedUser1();
    const id = recordOp({ opKind: "sweep", fromAddress: FAKE_DEPOSIT_ADDR_1, toAddress: null, coinTypeIn: SUI_TYPE, amountIn: 1n, initiatedBy: "t" });
    markOpResult(id, { status: "succeeded" });
    recordOp({ opKind: "sweep", fromAddress: FAKE_DEPOSIT_ADDR_1, toAddress: null, coinTypeIn: SUI_TYPE, amountIn: 2n, initiatedBy: "t" });
    expect(listOps({ status: "succeeded" }).length).toBe(1);
    expect(listOps({ status: "pending" }).length).toBe(1);
  });
});

// ==========================================================================
// sweepDepositAddress tests
// ==========================================================================

describe("sweepDepositAddress — SUI full balance leaves gas reserve", () => {
  it("sweeps total minus GAS_RESERVE_MIST when no amount given", async () => {
    seedUser1();
    const balance = 200_000_000n; // 0.2 SUI
    const expected = balance - GAS_RESERVE_MIST; // 0.15 SUI

    const { client, txSubmissions } = makeFakeClient({
      coins: {
        [`${FAKE_DEPOSIT_ADDR_1}::${SUI_TYPE}`]: suiCoins(balance),
      },
    });

    const result = await sweepDepositAddress({
      derivationIndex: 1,
      coinType: SUI_TYPE,
      to: FAKE_MASTER_ADDR,
      client,
      _keypairProvider: FAKE_KP,
    });

    expect(result.amountSwept).toBe(expected);
    expect(result.dryRun).toBe(false);
    expect(result.digest).toBeDefined();
    expect(txSubmissions.length).toBe(1);
    expect(txSubmissions[0]!.from).toBe(FAKE_DEPOSIT_ADDR_1);

    // Op row should be succeeded.
    const ops = listOps({ opKind: "sweep" });
    expect(ops.length).toBe(1);
    expect(ops[0]!.status).toBe("succeeded");
    expect(ops[0]!.amountIn).toBe(expected);

    // Balance cache should be seeded to the post-sweep balance.
    const snap = getAddressBalance(FAKE_DEPOSIT_ADDR_1, SUI_TYPE);
    expect(snap?.lastSeenBalance).toBe(GAS_RESERVE_MIST);
  });

  it("skips when balance equals gas reserve exactly", async () => {
    seedUser1();
    const { client, txSubmissions } = makeFakeClient({
      coins: {
        [`${FAKE_DEPOSIT_ADDR_1}::${SUI_TYPE}`]: suiCoins(GAS_RESERVE_MIST),
      },
    });

    const result = await sweepDepositAddress({
      derivationIndex: 1,
      coinType: SUI_TYPE,
      to: FAKE_MASTER_ADDR,
      client,
      _keypairProvider: FAKE_KP,
    });

    expect(result.amountSwept).toBe(0n);
    expect(txSubmissions.length).toBe(0);
    expect(listOps().length).toBe(0); // no ops row when skipped
  });
});

describe("sweepDepositAddress — non-gasless coin without SUI gas → loud error + ops row failed", () => {
  it("throws a clear error and records a failed ops row (non-allowlisted coin, no SUI)", async () => {
    seedUser1();
    // Deposit address has a non-gasless coin but NO SUI for gas.
    // FAKE_NONGAS_COIN is not in GASLESS_STABLECOINS, so the gas-paid path is taken.
    const { client } = makeFakeClient({
      coins: {
        [`${FAKE_DEPOSIT_ADDR_1}::${canonicalType(FAKE_NONGAS_COIN)}`]: fakeNonGasCoins(1_000_000n),
        // No SUI coins.
      },
    });

    await expect(
      sweepDepositAddress({
        derivationIndex: 1,
        coinType: FAKE_NONGAS_COIN,
        to: FAKE_MASTER_ADDR,
        client,
        _keypairProvider: FAKE_KP,
      }),
    ).rejects.toThrow(/no SUI for gas/);

    // Ops row must exist and be failed (not silently skipped).
    const ops = listOps({ opKind: "sweep" });
    expect(ops.length).toBe(1);
    expect(ops[0]!.status).toBe("failed");
    expect(ops[0]!.error).toMatch(/no SUI for gas/);
  });

  it("USDC with forceGas=true AND no SUI → throws no SUI for gas (legacy path chosen)", async () => {
    seedUser1();
    const { client } = makeFakeClient({
      coins: {
        [`${FAKE_DEPOSIT_ADDR_1}::${canonicalType(USDC_TYPE)}`]: usdcCoins(1_000_000n),
        // No SUI coins.
      },
    });

    await expect(
      sweepDepositAddress({
        derivationIndex: 1,
        coinType: USDC_TYPE,
        to: FAKE_MASTER_ADDR,
        client,
        forceGas: true, // force the legacy path even though USDC is gasless-eligible
        _keypairProvider: FAKE_KP,
      }),
    ).rejects.toThrow(/no SUI for gas/);
  });
});

describe("sweepDepositAddress — balance cache seeded after successful sweep", () => {
  it("watcher tick after sweep sees delta=0 (no negative-delta mis-booking)", async () => {
    seedUser1();
    const balance = 300_000_000n;

    // Seed the cache with the original balance (as if watcher ran before sweep).
    upsertAddressBalance({
      depositAddress: FAKE_DEPOSIT_ADDR_1,
      coinType: SUI_TYPE,
      lastSeenBalance: balance,
      lastSeenMs: Date.now(),
    });

    const { client } = makeFakeClient({
      coins: {
        [`${FAKE_DEPOSIT_ADDR_1}::${SUI_TYPE}`]: suiCoins(balance),
      },
    });

    await sweepDepositAddress({
      derivationIndex: 1,
      coinType: SUI_TYPE,
      to: FAKE_MASTER_ADDR,
      client,
      _keypairProvider: FAKE_KP,
    });

    // After sweep: cache should reflect remaining balance (gas reserve).
    const snap = getAddressBalance(FAKE_DEPOSIT_ADDR_1, SUI_TYPE);
    expect(snap?.lastSeenBalance).toBe(GAS_RESERVE_MIST);

    // Simulate watcher tick: delta = currentBalance - cachedBalance.
    // If the client now reports GAS_RESERVE_MIST, delta = 0 → noop.
    const currentBalance = GAS_RESERVE_MIST;
    const delta = currentBalance - (snap?.lastSeenBalance ?? 0n);
    expect(delta).toBe(0n); // No negative delta — watcher won't mis-book.
  });
});

describe("sweepDepositAddress — dryRun writes nothing", () => {
  it("returns plan without submitting tx or writing ops rows", async () => {
    seedUser1();
    const balance = 200_000_000n;
    const { client, txSubmissions } = makeFakeClient({
      coins: {
        [`${FAKE_DEPOSIT_ADDR_1}::${SUI_TYPE}`]: suiCoins(balance),
      },
    });

    const result = await sweepDepositAddress({
      derivationIndex: 1,
      coinType: SUI_TYPE,
      to: FAKE_MASTER_ADDR,
      client,
      dryRun: true,
      _keypairProvider: FAKE_KP,
    });

    expect(result.dryRun).toBe(true);
    expect(result.amountSwept).toBe(balance - GAS_RESERVE_MIST);
    expect(txSubmissions.length).toBe(0);
    expect(listOps().length).toBe(0); // no ops row in dry-run
    // Balance cache should NOT be seeded in dry-run.
    expect(getAddressBalance(FAKE_DEPOSIT_ADDR_1, SUI_TYPE)).toBeNull();
  });
});

describe("sweepDepositAddress — explicit amount override", () => {
  it("sweeps exactly the requested amount when given", async () => {
    seedUser1();
    const balance = 500_000_000n;
    const requested = 100_000_000n;

    const { client, txSubmissions } = makeFakeClient({
      coins: {
        [`${FAKE_DEPOSIT_ADDR_1}::${SUI_TYPE}`]: suiCoins(balance),
      },
    });

    const result = await sweepDepositAddress({
      derivationIndex: 1,
      coinType: SUI_TYPE,
      to: FAKE_MASTER_ADDR,
      amount: requested,
      client,
      _keypairProvider: FAKE_KP,
    });

    expect(result.amountSwept).toBe(requested);
    expect(txSubmissions.length).toBe(1);
  });

  it("throws when requested amount exceeds balance", async () => {
    seedUser1();
    const { client } = makeFakeClient({
      coins: {
        [`${FAKE_DEPOSIT_ADDR_1}::${SUI_TYPE}`]: suiCoins(100n),
      },
    });

    await expect(
      sweepDepositAddress({
        derivationIndex: 1,
        coinType: SUI_TYPE,
        to: FAKE_MASTER_ADDR,
        amount: 200n,
        client,
        _keypairProvider: FAKE_KP,
      }),
    ).rejects.toThrow(/only has 100/);
  });
});

describe("sweepDepositAddress — ops row status transitions", () => {
  it("pending → succeeded on success", async () => {
    seedUser1();
    const { client } = makeFakeClient({
      coins: {
        [`${FAKE_DEPOSIT_ADDR_1}::${SUI_TYPE}`]: suiCoins(200_000_000n),
      },
      digest: "0xsuccessdigest",
    });

    await sweepDepositAddress({
      derivationIndex: 1,
      coinType: SUI_TYPE,
      to: FAKE_MASTER_ADDR,
      client,
      _keypairProvider: FAKE_KP,
    });

    const ops = listOps();
    expect(ops[0]!.status).toBe("succeeded");
    expect(ops[0]!.digest).toBe("0xsuccessdigest");
  });

  it("pending → failed when on-chain tx fails", async () => {
    seedUser1();
    const { client } = makeFakeClient({
      coins: {
        [`${FAKE_DEPOSIT_ADDR_1}::${SUI_TYPE}`]: suiCoins(200_000_000n),
      },
      failTx: true,
    });

    await expect(
      sweepDepositAddress({
        derivationIndex: 1,
        coinType: SUI_TYPE,
        to: FAKE_MASTER_ADDR,
        client,
        _keypairProvider: FAKE_KP,
      }),
    ).rejects.toThrow();

    const ops = listOps();
    expect(ops[0]!.status).toBe("failed");
    expect(ops[0]!.error).toMatch(/simulated failure/);
  });
});

// ==========================================================================
// sweepAll — dust filter
// ==========================================================================

describe("sweepAll — minAmount dust skip", () => {
  it("skips addresses whose cached balance is below minAmount", async () => {
    seedUser1();
    seedUser2();

    // Only user1 has enough balance.
    upsertAddressBalance({
      depositAddress: FAKE_DEPOSIT_ADDR_1,
      coinType: SUI_TYPE,
      lastSeenBalance: 200_000_000n,
      lastSeenMs: Date.now(),
    });
    upsertAddressBalance({
      depositAddress: FAKE_DEPOSIT_ADDR_2,
      coinType: SUI_TYPE,
      lastSeenBalance: 1_000n, // below dust threshold
      lastSeenMs: Date.now(),
    });

    const { client } = makeFakeClient({
      coins: {
        [`${FAKE_DEPOSIT_ADDR_1}::${SUI_TYPE}`]: suiCoins(200_000_000n),
        [`${FAKE_DEPOSIT_ADDR_2}::${SUI_TYPE}`]: suiCoins(1_000n),
      },
    });

    const report = await sweepAll({
      coinType: SUI_TYPE,
      to: FAKE_MASTER_ADDR,
      minAmount: 100_000_000n, // 0.1 SUI threshold
      client,
      _keypairProvider: FAKE_KP,
    });

    // user1 swept, user2 skipped.
    expect(report.swept.length).toBe(1);
    expect(report.swept[0]!.depositAddress).toBe(FAKE_DEPOSIT_ADDR_1);
    expect(report.skipped.some((s) => s.depositAddress === FAKE_DEPOSIT_ADDR_2)).toBe(true);
    expect(report.errors.length).toBe(0);
  });
});

// ==========================================================================
// refundUser tests
// ==========================================================================

describe("refundUser — zeroes credits and writes ops rows", () => {
  it("transfers SUI and zeros credits on success", async () => {
    registerUserTx(FAKE_USER1_ADDR, () => FAKE_DEPOSIT_ADDR_1);
    // Manually bump credits to simulate prior deposits.
    const { getDb } = await import("../../src/db/client.ts");
    getDb().prepare(`UPDATE treasury_users SET credits = 500 WHERE sui_address = '${FAKE_USER1_ADDR}'`).run();

    const balance = 300_000_000n;
    // Seed the balance cache so sweepAll's db query finds coins.
    upsertAddressBalance({
      depositAddress: FAKE_DEPOSIT_ADDR_1,
      coinType: SUI_TYPE,
      lastSeenBalance: balance,
      lastSeenMs: Date.now(),
    });

    const { client, txSubmissions } = makeFakeClient({
      coins: {
        [`${FAKE_DEPOSIT_ADDR_1}::${SUI_TYPE}`]: suiCoins(balance),
      },
    });

    const result = await refundUser({
      suiAddress: FAKE_USER1_ADDR,
      client,
      _keypairProvider: FAKE_KP,
    });

    expect(result.creditsBefore).toBe(500);
    expect(result.creditsAfter).toBe(0);
    expect(result.transfers.length).toBe(1);
    expect(result.transfers[0]!.coinType).toBe(SUI_TYPE);
    expect(result.transfers[0]!.amount).toBe(balance - GAS_RESERVE_MIST);
    expect(txSubmissions.length).toBe(1);
    expect(txSubmissions[0]!.from).toBe(FAKE_DEPOSIT_ADDR_1);

    // Treasury_ops row should exist.
    const ops = listOps({ opKind: "transfer" });
    expect(ops.length).toBe(1);
    expect(ops[0]!.status).toBe("succeeded");
    expect(ops[0]!.toAddress).toBe(FAKE_USER1_ADDR);

    // Credits should be zeroed in DB.
    const user = findUserBySuiAddress(FAKE_USER1_ADDR);
    expect(user?.credits).toBe(0);
  });
});

describe("refundUser — dryRun writes nothing", () => {
  it("returns plan without submitting tx or writing ops rows or changing credits", async () => {
    registerUserTx(FAKE_USER1_ADDR, () => FAKE_DEPOSIT_ADDR_1);
    const { getDb } = await import("../../src/db/client.ts");
    getDb().prepare(`UPDATE treasury_users SET credits = 200 WHERE sui_address = '${FAKE_USER1_ADDR}'`).run();

    upsertAddressBalance({
      depositAddress: FAKE_DEPOSIT_ADDR_1,
      coinType: SUI_TYPE,
      lastSeenBalance: 200_000_000n,
      lastSeenMs: Date.now(),
    });

    const { client, txSubmissions } = makeFakeClient({
      coins: {
        [`${FAKE_DEPOSIT_ADDR_1}::${SUI_TYPE}`]: suiCoins(200_000_000n),
      },
    });

    const result = await refundUser({
      suiAddress: FAKE_USER1_ADDR,
      client,
      dryRun: true,
      _keypairProvider: FAKE_KP,
    });

    expect(result.dryRun).toBe(true);
    expect(txSubmissions.length).toBe(0);
    expect(listOps().length).toBe(0); // no ops rows
    // Credits must not change in dry-run.
    expect(findUserBySuiAddress(FAKE_USER1_ADDR)?.credits).toBe(200);
    expect(result.creditsBefore).toBe(200);
    expect(result.creditsAfter).toBe(0); // shows what WOULD happen
  });
});

describe("refundUser — unregistered user throws", () => {
  it("throws when user not found", async () => {
    const { client } = makeFakeClient({ coins: {} });
    await expect(
      refundUser({ suiAddress: "0x" + "ff".repeat(32), client, _keypairProvider: FAKE_KP }),
    ).rejects.toThrow(/no treasury user registered/);
  });
});

describe("refundUser — non-gasless coin without gas throws", () => {
  it("throws when deposit address has a non-allowlisted coin but no SUI for gas", async () => {
    registerUserTx(FAKE_USER1_ADDR, () => FAKE_DEPOSIT_ADDR_1);

    upsertAddressBalance({
      depositAddress: FAKE_DEPOSIT_ADDR_1,
      coinType: canonicalType(FAKE_NONGAS_COIN),
      lastSeenBalance: 5_000_000n,
      lastSeenMs: Date.now(),
    });

    const { client } = makeFakeClient({
      coins: {
        [`${FAKE_DEPOSIT_ADDR_1}::${canonicalType(FAKE_NONGAS_COIN)}`]: fakeNonGasCoins(5_000_000n),
        // No SUI.
      },
    });

    await expect(
      refundUser({ suiAddress: FAKE_USER1_ADDR, client, _keypairProvider: FAKE_KP }),
    ).rejects.toThrow(/insufficient SUI for gas/);
  });

  it("throws when deposit address has USDC with forceGas=true but no SUI for gas", async () => {
    registerUserTx(FAKE_USER1_ADDR, () => FAKE_DEPOSIT_ADDR_1);

    upsertAddressBalance({
      depositAddress: FAKE_DEPOSIT_ADDR_1,
      coinType: canonicalType(USDC_TYPE),
      lastSeenBalance: 5_000_000n,
      lastSeenMs: Date.now(),
    });

    const { client } = makeFakeClient({
      coins: {
        [`${FAKE_DEPOSIT_ADDR_1}::${canonicalType(USDC_TYPE)}`]: usdcCoins(5_000_000n),
        // No SUI.
      },
    });

    await expect(
      refundUser({ suiAddress: FAKE_USER1_ADDR, client, forceGas: true, _keypairProvider: FAKE_KP }),
    ).rejects.toThrow(/insufficient SUI for gas/);
  });
});

describe("refundUser — balance cache seeded after refund", () => {
  it("watcher tick after refund sees delta=0 for transferred coins", async () => {
    registerUserTx(FAKE_USER1_ADDR, () => FAKE_DEPOSIT_ADDR_1);
    const balance = 200_000_000n;

    upsertAddressBalance({
      depositAddress: FAKE_DEPOSIT_ADDR_1,
      coinType: SUI_TYPE,
      lastSeenBalance: balance,
      lastSeenMs: Date.now(),
    });

    const { client } = makeFakeClient({
      coins: {
        [`${FAKE_DEPOSIT_ADDR_1}::${SUI_TYPE}`]: suiCoins(balance),
      },
    });

    await refundUser({ suiAddress: FAKE_USER1_ADDR, client, _keypairProvider: FAKE_KP });

    // After refund, SUI cache should be 0 (the remainder after gas was sent too).
    const snap = getAddressBalance(FAKE_DEPOSIT_ADDR_1, SUI_TYPE);
    expect(snap?.lastSeenBalance).toBe(0n);

    // delta = 0 - 0 = 0 → watcher noop.
    const delta = 0n - (snap?.lastSeenBalance ?? 0n);
    expect(delta).toBe(0n);
  });
});

// ==========================================================================
// Confirm CLI-level guard is outside operator.ts (no prompt in fn)
// ==========================================================================

describe("refundUser — no --confirm guard in fn (CLI responsibility)", () => {
  it("executes without any confirmation flag in the function args", async () => {
    registerUserTx(FAKE_USER1_ADDR, () => FAKE_DEPOSIT_ADDR_1);
    upsertAddressBalance({
      depositAddress: FAKE_DEPOSIT_ADDR_1,
      coinType: SUI_TYPE,
      lastSeenBalance: 100_000_000n,
      lastSeenMs: Date.now(),
    });

    const { client } = makeFakeClient({
      coins: {
        [`${FAKE_DEPOSIT_ADDR_1}::${SUI_TYPE}`]: suiCoins(100_000_000n),
      },
    });

    // No dryRun (default is false), no confirm param — function runs directly.
    const result = await refundUser({ suiAddress: FAKE_USER1_ADDR, client, _keypairProvider: FAKE_KP });
    expect(result.dryRun).toBe(false);
    expect(result.creditsAfter).toBe(0);
  });
});

// ==========================================================================
// Gasless sweep — USDC with zero SUI succeeds
// ==========================================================================

describe("sweepDepositAddress — USDC gasless path (zero SUI on address)", () => {
  it("USDC sweep succeeds with zero SUI on deposit address", async () => {
    seedUser1();
    const usdcBalance = 1_000_000n; // 1 USDC (above 10_000 minimum)

    // Deposit address has USDC but absolutely NO SUI — gasless should succeed.
    const { client, txSubmissions } = makeFakeClient({
      coins: {
        [`${FAKE_DEPOSIT_ADDR_1}::${canonicalType(USDC_TYPE)}`]: usdcCoins(usdcBalance),
        // No SUI at all.
      },
    });

    const result = await sweepDepositAddress({
      derivationIndex: 1,
      coinType: USDC_TYPE,
      to: FAKE_MASTER_ADDR,
      client,
      _keypairProvider: FAKE_KP,
    });

    expect(result.amountSwept).toBe(usdcBalance);
    expect(result.dryRun).toBe(false);
    expect(result.path).toBe("gasless");
    expect(result.digest).toBeDefined();
    expect(txSubmissions.length).toBe(1);
    expect(txSubmissions[0]!.from).toBe(FAKE_DEPOSIT_ADDR_1);

    // Op row should be succeeded, with path recorded in initiatedBy.
    const ops = listOps({ opKind: "sweep" });
    expect(ops.length).toBe(1);
    expect(ops[0]!.status).toBe("succeeded");
    expect(ops[0]!.initiatedBy).toContain("path:gasless");
  });

  it("USDC dry-run shows gasless path", async () => {
    seedUser1();
    const { client, txSubmissions } = makeFakeClient({
      coins: {
        [`${FAKE_DEPOSIT_ADDR_1}::${canonicalType(USDC_TYPE)}`]: usdcCoins(500_000n),
      },
    });

    const result = await sweepDepositAddress({
      derivationIndex: 1,
      coinType: USDC_TYPE,
      to: FAKE_MASTER_ADDR,
      client,
      dryRun: true,
      _keypairProvider: FAKE_KP,
    });

    expect(result.dryRun).toBe(true);
    expect(result.path).toBe("gasless");
    expect(txSubmissions.length).toBe(0);
    expect(listOps().length).toBe(0);
  });

  it("USDC isGaslessEligible returns true (sanity check for routing)", () => {
    expect(isGaslessEligible(USDC_TYPE)).toBe(true);
  });
});

// ==========================================================================
// Gasless sweep — below minimum is skipped (not silently gas-paid)
// ==========================================================================

describe("sweepDepositAddress — USDC below gasless minimum is skipped", () => {
  it("skips with path=skipped when USDC balance is below 10_000 atomic", async () => {
    seedUser1();
    const belowMin = 9_999n; // just below 10_000 minimum

    const { client, txSubmissions } = makeFakeClient({
      coins: {
        [`${FAKE_DEPOSIT_ADDR_1}::${canonicalType(USDC_TYPE)}`]: usdcCoins(belowMin),
      },
    });

    const result = await sweepDepositAddress({
      derivationIndex: 1,
      coinType: USDC_TYPE,
      to: FAKE_MASTER_ADDR,
      client,
      _keypairProvider: FAKE_KP,
    });

    // Must NOT silently fall back to gas path — must be skipped.
    expect(result.amountSwept).toBe(0n);
    expect(result.path).toBe("skipped");
    expect(txSubmissions.length).toBe(0);
    expect(listOps().length).toBe(0); // no ops row for a below-min skip
  });

  it("below-min USDC with forceGas=true AND SUI available → succeeds via gas-paid path", async () => {
    seedUser1();
    const belowMin = 9_999n;

    const { client, txSubmissions } = makeFakeClient({
      coins: {
        [`${FAKE_DEPOSIT_ADDR_1}::${canonicalType(USDC_TYPE)}`]: usdcCoins(belowMin),
        // Provide SUI so the gas-paid path can proceed.
        [`${FAKE_DEPOSIT_ADDR_1}::${SUI_TYPE}`]: suiCoins(GAS_RESERVE_MIST + 10_000_000n),
      },
    });

    const result = await sweepDepositAddress({
      derivationIndex: 1,
      coinType: USDC_TYPE,
      to: FAKE_MASTER_ADDR,
      client,
      forceGas: true,
      _keypairProvider: FAKE_KP,
    });

    expect(result.amountSwept).toBe(belowMin);
    expect(result.path).toBe("gas");
    expect(txSubmissions.length).toBe(1);
  });
});

// ==========================================================================
// Gasless sweep — forceGas routes through legacy gas path
// ==========================================================================

describe("sweepDepositAddress — USDC with forceGas uses gas-paid path", () => {
  it("forceGas=true routes USDC through the gas-paid path (path=gas)", async () => {
    seedUser1();
    const usdcBalance = 1_000_000n;

    const { client, txSubmissions } = makeFakeClient({
      coins: {
        [`${FAKE_DEPOSIT_ADDR_1}::${canonicalType(USDC_TYPE)}`]: usdcCoins(usdcBalance),
        [`${FAKE_DEPOSIT_ADDR_1}::${SUI_TYPE}`]: suiCoins(GAS_RESERVE_MIST + 20_000_000n),
      },
    });

    const result = await sweepDepositAddress({
      derivationIndex: 1,
      coinType: USDC_TYPE,
      to: FAKE_MASTER_ADDR,
      client,
      forceGas: true,
      _keypairProvider: FAKE_KP,
    });

    expect(result.amountSwept).toBe(usdcBalance);
    expect(result.path).toBe("gas");
    expect(txSubmissions.length).toBe(1);

    // Op row should record gas path.
    const ops = listOps({ opKind: "sweep" });
    expect(ops[0]!.initiatedBy).toContain("path:gas");
  });
});

// ==========================================================================
// refundUser — USDC gasless + SUI gas mix
// ==========================================================================

describe("refundUser — gasless (USDC) + gas (SUI) mixed refund", () => {
  it("refunds SUI via gas path and USDC via gasless path; both ops rows recorded", async () => {
    registerUserTx(FAKE_USER1_ADDR, () => FAKE_DEPOSIT_ADDR_1);
    const { getDb } = await import("../../src/db/client.ts");
    getDb().prepare(`UPDATE treasury_users SET credits = 300 WHERE sui_address = '${FAKE_USER1_ADDR}'`).run();

    const suiBalance = 300_000_000n;
    const usdcBalance = 2_000_000n;

    upsertAddressBalance({
      depositAddress: FAKE_DEPOSIT_ADDR_1,
      coinType: SUI_TYPE,
      lastSeenBalance: suiBalance,
      lastSeenMs: Date.now(),
    });
    upsertAddressBalance({
      depositAddress: FAKE_DEPOSIT_ADDR_1,
      coinType: canonicalType(USDC_TYPE),
      lastSeenBalance: usdcBalance,
      lastSeenMs: Date.now(),
    });

    const { client, txSubmissions } = makeFakeClient({
      coins: {
        [`${FAKE_DEPOSIT_ADDR_1}::${SUI_TYPE}`]: suiCoins(suiBalance),
        [`${FAKE_DEPOSIT_ADDR_1}::${canonicalType(USDC_TYPE)}`]: usdcCoins(usdcBalance),
      },
    });

    const result = await refundUser({
      suiAddress: FAKE_USER1_ADDR,
      client,
      _keypairProvider: FAKE_KP,
    });

    expect(result.dryRun).toBe(false);
    expect(result.creditsAfter).toBe(0);
    expect(result.transfers.length).toBe(2);

    // Find SUI transfer.
    const suiTransfer = result.transfers.find((t) => t.coinType === SUI_TYPE);
    expect(suiTransfer).toBeDefined();
    expect(suiTransfer!.path).toBe("gas");
    expect(suiTransfer!.amount).toBe(suiBalance - GAS_RESERVE_MIST);

    // Find USDC transfer.
    const usdcTransfer = result.transfers.find(
      (t) => t.coinType === canonicalType(USDC_TYPE),
    );
    expect(usdcTransfer).toBeDefined();
    expect(usdcTransfer!.path).toBe("gasless");
    expect(usdcTransfer!.amount).toBe(usdcBalance);

    // Two txs submitted.
    expect(txSubmissions.length).toBe(2);

    // Ops rows: one 'transfer' for SUI (gas), one for USDC (gasless).
    const ops = listOps({ opKind: "transfer" });
    expect(ops.length).toBe(2);
    const suiOp = ops.find((o) => o.coinTypeIn === SUI_TYPE);
    const usdcOp = ops.find((o) => o.coinTypeIn === canonicalType(USDC_TYPE));
    expect(suiOp!.initiatedBy).toContain("path:gas");
    expect(usdcOp!.initiatedBy).toContain("path:gasless");
  });

  it("USDC-only refund succeeds with zero SUI on deposit address", async () => {
    registerUserTx(FAKE_USER1_ADDR, () => FAKE_DEPOSIT_ADDR_1);

    upsertAddressBalance({
      depositAddress: FAKE_DEPOSIT_ADDR_1,
      coinType: canonicalType(USDC_TYPE),
      lastSeenBalance: 500_000n,
      lastSeenMs: Date.now(),
    });

    const { client, txSubmissions } = makeFakeClient({
      coins: {
        // Only USDC — no SUI at all.
        [`${FAKE_DEPOSIT_ADDR_1}::${canonicalType(USDC_TYPE)}`]: usdcCoins(500_000n),
      },
    });

    const result = await refundUser({
      suiAddress: FAKE_USER1_ADDR,
      client,
      _keypairProvider: FAKE_KP,
    });

    expect(result.transfers.length).toBe(1);
    expect(result.transfers[0]!.coinType).toBe(canonicalType(USDC_TYPE));
    expect(result.transfers[0]!.path).toBe("gasless");
    expect(txSubmissions.length).toBe(1);
    expect(result.creditsAfter).toBe(0);
  });
});

// ==========================================================================
// refundUser — ops rows record path in initiatedBy
// ==========================================================================

describe("refundUser — ops row path field", () => {
  it("ops row initiatedBy contains path:gasless for USDC refund", async () => {
    registerUserTx(FAKE_USER1_ADDR, () => FAKE_DEPOSIT_ADDR_1);

    upsertAddressBalance({
      depositAddress: FAKE_DEPOSIT_ADDR_1,
      coinType: canonicalType(USDC_TYPE),
      lastSeenBalance: 100_000n,
      lastSeenMs: Date.now(),
    });

    const { client } = makeFakeClient({
      coins: {
        [`${FAKE_DEPOSIT_ADDR_1}::${canonicalType(USDC_TYPE)}`]: usdcCoins(100_000n),
      },
    });

    await refundUser({
      suiAddress: FAKE_USER1_ADDR,
      client,
      initiatedBy: "test-operator",
      _keypairProvider: FAKE_KP,
    });

    const ops = listOps({ opKind: "transfer" });
    expect(ops.length).toBe(1);
    expect(ops[0]!.initiatedBy).toBe("test-operator|path:gasless");
  });
});
