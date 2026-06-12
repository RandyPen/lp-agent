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
const USDC_TYPE = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::usdc";

interface TxRecord {
  from: string;
  commands: string; // serialised summary for assertions
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
      txSubmissions.push({
        from: signer.toSuiAddress(),
        commands: JSON.stringify(transaction),
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

describe("sweepDepositAddress — non-SUI without SUI gas → loud error + ops row failed", () => {
  it("throws a clear error and records a failed ops row", async () => {
    seedUser1();
    // Deposit address has USDC but NO SUI for gas.
    const { client } = makeFakeClient({
      coins: {
        [`${FAKE_DEPOSIT_ADDR_1}::${USDC_TYPE}`]: usdcCoins(1_000_000n),
        // No SUI coins.
      },
    });

    await expect(
      sweepDepositAddress({
        derivationIndex: 1,
        coinType: USDC_TYPE,
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

describe("refundUser — non-SUI without gas throws", () => {
  it("throws when deposit address has USDC but no SUI for gas", async () => {
    registerUserTx(FAKE_USER1_ADDR, () => FAKE_DEPOSIT_ADDR_1);

    upsertAddressBalance({
      depositAddress: FAKE_DEPOSIT_ADDR_1,
      coinType: USDC_TYPE,
      lastSeenBalance: 5_000_000n,
      lastSeenMs: Date.now(),
    });

    const { client } = makeFakeClient({
      coins: {
        [`${FAKE_DEPOSIT_ADDR_1}::${USDC_TYPE}`]: usdcCoins(5_000_000n),
        // No SUI.
      },
    });

    await expect(
      refundUser({ suiAddress: FAKE_USER1_ADDR, client, _keypairProvider: FAKE_KP }),
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
