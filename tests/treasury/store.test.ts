/**
 * Tests for src/treasury/store.ts — atomic SQL access.
 * Uses an in-memory SQLite via openDb(":memory:")? — actually openDb expects
 * a path so use a per-test temp file.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, resetDbCacheForTests } from "../../src/db/client.ts";
import {
  attemptChargeTx,
  findChargeByNonce,
  findUserBySuiAddress,
  getAddressBalance,
  getCreditRate,
  listUsers,
  recordDepositTx,
  refundChargeTx,
  registerUserTx,
  upsertAddressBalance,
  upsertCreditRate,
} from "../../src/treasury/store.ts";

let tmpDir: string;

function freshDb(): void {
  resetDbCacheForTests();
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDir = mkdtempSync(join(tmpdir(), "treasury-store-"));
  openDb(join(tmpDir, "test.db"));
}

beforeEach(() => freshDb());
afterAll(() => {
  resetDbCacheForTests();
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

const SUI_A = "0xaaaa";
const SUI_B = "0xbbbb";
const USDC = "0xdba34::usdc::USDC";

describe("registerUserTx", () => {
  it("assigns monotonic derivation indices starting at 1", () => {
    const u1 = registerUserTx(SUI_A, (i) => `0xdep_${i}`);
    const u2 = registerUserTx(SUI_B, (i) => `0xdep_${i}`);
    expect(u1.derivationIndex).toBe(1);
    expect(u2.derivationIndex).toBe(2);
    expect(u1.depositAddress).toBe("0xdep_1");
    expect(u2.depositAddress).toBe("0xdep_2");
  });

  it("re-registering same sui_address returns the existing row", () => {
    const u1 = registerUserTx(SUI_A, (i) => `0xdep_${i}`);
    const u2 = registerUserTx(SUI_A, (i) => `0xdep_${i}`);
    expect(u2.derivationIndex).toBe(u1.derivationIndex);
    expect(u2.depositAddress).toBe(u1.depositAddress);
    expect(listUsers()).toHaveLength(1);
  });

  it("findUserBySuiAddress / findUserByDepositAddress round-trip", () => {
    const u = registerUserTx(SUI_A, (i) => `0xdep_${i}`);
    expect(findUserBySuiAddress(SUI_A)?.depositAddress).toBe(u.depositAddress);
    expect(findUserBySuiAddress("0xnobody")).toBeNull();
  });
});

describe("credit rates", () => {
  it("upsert + get", () => {
    expect(getCreditRate(USDC)).toBeNull();
    upsertCreditRate({ coinType: USDC, rateNum: 1n, rateDen: 10000n, updatedBy: "test" });
    const r = getCreditRate(USDC);
    expect(r?.rateNum).toBe(1n);
    expect(r?.rateDen).toBe(10000n);
  });

  it("rejects rateDen <= 0", () => {
    expect(() => upsertCreditRate({ coinType: USDC, rateNum: 1n, rateDen: 0n })).toThrow();
  });

  it("overwrites prior row on conflict", () => {
    upsertCreditRate({ coinType: USDC, rateNum: 1n, rateDen: 10000n });
    upsertCreditRate({ coinType: USDC, rateNum: 5n, rateDen: 100n });
    expect(getCreditRate(USDC)?.rateNum).toBe(5n);
  });
});

describe("address balances", () => {
  it("upsert + get", () => {
    expect(getAddressBalance("0xdep", USDC)).toBeNull();
    upsertAddressBalance({
      depositAddress: "0xdep",
      coinType: USDC,
      lastSeenBalance: 5_000_000n,
      lastSeenMs: 1000,
    });
    expect(getAddressBalance("0xdep", USDC)?.lastSeenBalance).toBe(5_000_000n);
  });
});

describe("recordDepositTx (atomic deposit + credit + cache)", () => {
  it("inserts deposit row, bumps user credits, updates cache — all in one tx", () => {
    registerUserTx(SUI_A, (i) => `0xdep_${i}`);
    recordDepositTx({
      id: "dep_1",
      suiAddress: SUI_A,
      depositAddress: "0xdep_1",
      coinType: USDC,
      amountDelta: 5_000_000n,
      prevBalance: 0n,
      newBalance: 5_000_000n,
      creditsGranted: 500,
      rateNum: 1n,
      rateDen: 10000n,
      observedAtMs: 1000,
    });
    expect(findUserBySuiAddress(SUI_A)?.credits).toBe(500);
    expect(getAddressBalance("0xdep_1", USDC)?.lastSeenBalance).toBe(5_000_000n);
  });

  it("credits_granted=0 still records the row, no credit bump", () => {
    registerUserTx(SUI_A, (i) => `0xdep_${i}`);
    recordDepositTx({
      id: "dep_2",
      suiAddress: SUI_A,
      depositAddress: "0xdep_1",
      coinType: "0xunknown::TOKEN",
      amountDelta: 1_000_000n,
      prevBalance: 0n,
      newBalance: 1_000_000n,
      creditsGranted: 0,
      rateNum: null,
      rateDen: null,
      observedAtMs: 2000,
    });
    expect(findUserBySuiAddress(SUI_A)?.credits).toBe(0);
    expect(getAddressBalance("0xdep_1", "0xunknown::TOKEN")?.lastSeenBalance).toBe(1_000_000n);
  });
});

describe("attemptChargeTx", () => {
  function setupUser(credits: number): void {
    registerUserTx(SUI_A, (i) => `0xdep_${i}`);
    if (credits > 0) {
      recordDepositTx({
        id: "dep_seed",
        suiAddress: SUI_A,
        depositAddress: "0xdep_1",
        coinType: USDC,
        amountDelta: BigInt(credits * 10000),
        prevBalance: 0n,
        newBalance: BigInt(credits * 10000),
        creditsGranted: credits,
        rateNum: 1n,
        rateDen: 10000n,
        observedAtMs: 0,
      });
    }
  }

  it("ok path: debits credits and inserts ok row", () => {
    setupUser(1000);
    const charge = attemptChargeTx({
      nonce: "t1:pm1",
      suiAddress: SUI_A,
      pmId: "0xpm",
      cost: 100,
      memo: "test",
    });
    expect(charge.status).toBe("ok");
    expect(charge.creditsDebited).toBe(100);
    expect(findUserBySuiAddress(SUI_A)?.credits).toBe(900);
  });

  it("rejected: not_registered", () => {
    const charge = attemptChargeTx({
      nonce: "t1:pm1",
      suiAddress: "0xnobody",
      pmId: null,
      cost: 100,
      memo: null,
    });
    expect(charge.status).toBe("rejected");
    expect(charge.error).toBe("not_registered");
    expect(charge.creditsDebited).toBe(0);
  });

  it("rejected: insufficient_credits", () => {
    setupUser(50);
    const charge = attemptChargeTx({
      nonce: "t1:pm1",
      suiAddress: SUI_A,
      pmId: null,
      cost: 100,
      memo: null,
    });
    expect(charge.status).toBe("rejected");
    expect(charge.error).toBe("insufficient_credits");
    expect(findUserBySuiAddress(SUI_A)?.credits).toBe(50);
  });

  it("nonce replay returns existing row, no double-debit", () => {
    setupUser(1000);
    const first = attemptChargeTx({
      nonce: "t1:pm1",
      suiAddress: SUI_A,
      pmId: null,
      cost: 100,
      memo: null,
    });
    const second = attemptChargeTx({
      nonce: "t1:pm1",
      suiAddress: SUI_A,
      pmId: null,
      cost: 999, // try to re-charge differently — should noop
      memo: null,
    });
    expect(second.creditsDebited).toBe(first.creditsDebited);
    expect(findUserBySuiAddress(SUI_A)?.credits).toBe(900);
  });

  it("cost=0 inserts an ok row with debited=0 and does not change credits", () => {
    setupUser(1000);
    const charge = attemptChargeTx({
      nonce: "t1:pm1",
      suiAddress: SUI_A,
      pmId: null,
      cost: 0,
      memo: null,
    });
    expect(charge.status).toBe("ok");
    expect(charge.creditsDebited).toBe(0);
    expect(findUserBySuiAddress(SUI_A)?.credits).toBe(1000);
  });
});

describe("refundChargeTx", () => {
  it("restores credits and marks row refunded", () => {
    registerUserTx(SUI_A, (i) => `0xdep_${i}`);
    recordDepositTx({
      id: "dep_seed", suiAddress: SUI_A, depositAddress: "0xdep_1", coinType: USDC,
      amountDelta: 1_000_000n, prevBalance: 0n, newBalance: 1_000_000n,
      creditsGranted: 100, rateNum: 1n, rateDen: 10000n, observedAtMs: 0,
    });
    attemptChargeTx({
      nonce: "t1:pm1", suiAddress: SUI_A, pmId: null, cost: 100, memo: null,
    });
    expect(findUserBySuiAddress(SUI_A)?.credits).toBe(0);

    const refunded = refundChargeTx("t1:pm1", "rebalance_failed");
    expect(refunded).toBe(true);
    expect(findUserBySuiAddress(SUI_A)?.credits).toBe(100);
    expect(findChargeByNonce("t1:pm1")?.status).toBe("refunded");
  });

  it("noop for non-existent nonce", () => {
    expect(refundChargeTx("missing", "x")).toBe(false);
  });

  it("noop for already-refunded charge (idempotent)", () => {
    registerUserTx(SUI_A, (i) => `0xdep_${i}`);
    recordDepositTx({
      id: "dep_seed", suiAddress: SUI_A, depositAddress: "0xdep_1", coinType: USDC,
      amountDelta: 1_000_000n, prevBalance: 0n, newBalance: 1_000_000n,
      creditsGranted: 100, rateNum: 1n, rateDen: 10000n, observedAtMs: 0,
    });
    attemptChargeTx({ nonce: "n1", suiAddress: SUI_A, pmId: null, cost: 50, memo: null });
    refundChargeTx("n1", "reason1");
    expect(refundChargeTx("n1", "reason2")).toBe(false);
    expect(findUserBySuiAddress(SUI_A)?.credits).toBe(100); // not double-refunded
  });

  it("noop for rejected charge", () => {
    registerUserTx(SUI_A, (i) => `0xdep_${i}`);
    // No deposit — user has 0 credits — this attempt rejects
    attemptChargeTx({ nonce: "n2", suiAddress: SUI_A, pmId: null, cost: 100, memo: null });
    expect(refundChargeTx("n2", "x")).toBe(false);
  });
});
