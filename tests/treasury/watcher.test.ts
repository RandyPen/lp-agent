/**
 * Tests for src/treasury/watcher.ts — confirmation-debounced delta math +
 * idempotency + error isolation.
 *
 * Since the fix for the dip-then-recover double-credit bug, the watcher only
 * acts on a balance change (in either direction) after the SAME new balance
 * has been observed on BALANCE_CONFIRM_POLLS (=2) consecutive polls. Every
 * scenario below is written against that contract — a single poll never
 * credits or moves the baseline by itself.
 *
 * Uses a fake `WatcherClient` (stub of SuiClient.getAllBalances).
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, resetDbCacheForTests } from "../../src/db/client.ts";
import { createTreasuryWatcher, type WatcherClient } from "../../src/treasury/watcher.ts";
import {
  findUserBySuiAddress,
  getAddressBalance,
  listDepositsForUser,
  registerUserTx,
  upsertCreditRate,
} from "../../src/treasury/store.ts";
import { canonicalType } from "../../src/sui/lending/typeNorm.ts";

let tmpDir: string;

function freshDb(): void {
  resetDbCacheForTests();
  if (tmpDir) { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } }
  tmpDir = mkdtempSync(join(tmpdir(), "treasury-watcher-"));
  openDb(join(tmpDir, "test.db"));
}

beforeEach(() => freshDb());
afterAll(() => {
  resetDbCacheForTests();
  if (tmpDir) { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } }
});

const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const SUI_USER = "0xuser_a";

/** Fake client that returns scripted balances per address. */
function fakeClient(map: Record<string, Array<{ coinType: string; totalBalance: string }>>): WatcherClient {
  return {
    async getAllBalances({ owner }) {
      return map[owner] ?? [];
    },
  };
}

function seed(): { user: ReturnType<typeof registerUserTx> } {
  const user = registerUserTx(SUI_USER, () => "0xdep_1");
  upsertCreditRate({ coinType: canonicalType(USDC), rateNum: 1n, rateDen: 10000n });
  return { user };
}

/** 1-credit-per-atomic-unit rate — keeps expected credit amounts equal to the
 * raw deltas used in the confirmation-debounce scenarios below (matches the
 * defect description's 100 / 40 / 150 / 20 / 70 example numbers exactly). */
function seedUnitRate(): { user: ReturnType<typeof registerUserTx> } {
  const user = registerUserTx(SUI_USER, () => "0xdep_1");
  upsertCreditRate({ coinType: canonicalType(USDC), rateNum: 1n, rateDen: 1n });
  return { user };
}

describe("watcher — confirmation debounce", () => {
  it("a single poll never credits — first observation is only 'pending'", async () => {
    seed();
    const watcher = createTreasuryWatcher({
      client: fakeClient({ "0xdep_1": [{ coinType: USDC, totalBalance: "5000000" }] }),
      intervalMs: 1000,
    });
    const stats = await watcher.pollOnce();
    expect(stats.newDeposits).toBe(0);
    expect(stats.creditsGrantedTotal).toBe(0);
    expect(findUserBySuiAddress(SUI_USER)?.credits).toBe(0);
    // Baseline is untouched until confirmed.
    expect(getAddressBalance("0xdep_1", canonicalType(USDC))?.lastSeenBalance).toBe(0n);
  });

  it("second poll with the SAME balance confirms: inserts deposit row, credits user", async () => {
    seed();
    const watcher = createTreasuryWatcher({
      client: fakeClient({ "0xdep_1": [{ coinType: USDC, totalBalance: "5000000" }] }),
      intervalMs: 1000,
    });
    await watcher.pollOnce();
    const stats = await watcher.pollOnce();
    expect(stats.newDeposits).toBe(1);
    expect(stats.creditsGrantedTotal).toBe(500); // 5e6 × 1 / 1e4
    expect(stats.errors).toBe(0);
    expect(findUserBySuiAddress(SUI_USER)?.credits).toBe(500);
    expect(getAddressBalance("0xdep_1", canonicalType(USDC))?.lastSeenBalance).toBe(5_000_000n);
  });

  it("subsequent tick with same confirmed balance is a noop (no new deposits)", async () => {
    seed();
    const watcher = createTreasuryWatcher({
      client: fakeClient({ "0xdep_1": [{ coinType: USDC, totalBalance: "5000000" }] }),
      intervalMs: 1000,
    });
    await watcher.pollOnce();
    await watcher.pollOnce(); // confirms + credits
    const third = await watcher.pollOnce();
    expect(third.newDeposits).toBe(0);
    expect(third.creditsGrantedTotal).toBe(0);
    expect(findUserBySuiAddress(SUI_USER)?.credits).toBe(500);
  });

  it("incremental delta only credits the delta, once confirmed", async () => {
    seed();
    const balances = { "0xdep_1": [{ coinType: USDC, totalBalance: "5000000" }] };
    const watcher = createTreasuryWatcher({
      client: fakeClient(balances),
      intervalMs: 1000,
    });
    await watcher.pollOnce();
    await watcher.pollOnce(); // confirms 5,000,000 → credits 500
    balances["0xdep_1"] = [{ coinType: USDC, totalBalance: "7500000" }]; // +2.5e6
    await watcher.pollOnce(); // pending
    const stats = await watcher.pollOnce(); // confirms
    expect(stats.newDeposits).toBe(1);
    expect(stats.creditsGrantedTotal).toBe(250); // 2.5e6 × 1 / 1e4
    expect(findUserBySuiAddress(SUI_USER)?.credits).toBe(750);
  });

  it("dip-then-recover within the confirmation window results in ZERO net credit change (100 -> 40 -> 100)", async () => {
    seedUnitRate();
    const balances = { "0xdep_1": [{ coinType: USDC, totalBalance: "100" }] };
    const watcher = createTreasuryWatcher({ client: fakeClient(balances), intervalMs: 1000 });
    await watcher.pollOnce();
    await watcher.pollOnce(); // confirms baseline at 100 (0 -> 100 needs 2 polls too)
    expect(findUserBySuiAddress(SUI_USER)?.credits).toBeGreaterThanOrEqual(0);
    const creditsAtBaseline = findUserBySuiAddress(SUI_USER)?.credits ?? 0;

    balances["0xdep_1"] = [{ coinType: USDC, totalBalance: "40" }]; // dip
    const dipStats = await watcher.pollOnce(); // pending(40), count=1 — not confirmed
    expect(dipStats.newDeposits).toBe(0);
    expect(dipStats.creditsGrantedTotal).toBe(0);

    balances["0xdep_1"] = [{ coinType: USDC, totalBalance: "100" }]; // recover, before confirmation
    const recoverStats = await watcher.pollOnce();
    expect(recoverStats.newDeposits).toBe(0);
    expect(recoverStats.creditsGrantedTotal).toBe(0);

    // Net: zero credit change across the whole dip-then-recover sequence.
    expect(findUserBySuiAddress(SUI_USER)?.credits).toBe(creditsAtBaseline);
    expect(getAddressBalance("0xdep_1", canonicalType(USDC))?.lastSeenBalance).toBe(100n);
  });

  it("a genuine deposit (100 -> 150 -> 150) credits exactly once", async () => {
    seedUnitRate();
    const balances = { "0xdep_1": [{ coinType: USDC, totalBalance: "100" }] };
    const watcher = createTreasuryWatcher({ client: fakeClient(balances), intervalMs: 1000 });
    await watcher.pollOnce();
    await watcher.pollOnce(); // confirms baseline 100
    const baseCredits = findUserBySuiAddress(SUI_USER)?.credits ?? 0;

    balances["0xdep_1"] = [{ coinType: USDC, totalBalance: "150" }];
    await watcher.pollOnce(); // pending(150)
    const confirmStats = await watcher.pollOnce(); // confirmed: delta +50
    expect(confirmStats.newDeposits).toBe(1);
    expect(confirmStats.creditsGrantedTotal).toBe(50);

    // A third poll at the same (now-confirmed) balance must not re-credit.
    const again = await watcher.pollOnce();
    expect(again.newDeposits).toBe(0);
    expect(findUserBySuiAddress(SUI_USER)?.credits).toBe(baseCredits + 50);
  });

  it("a genuine sweep (100 -> 20 -> 20) lowers the baseline once and credits nothing, then a later deposit (20 -> 70 -> 70) credits exactly once", async () => {
    seedUnitRate();
    const balances = { "0xdep_1": [{ coinType: USDC, totalBalance: "100" }] };
    const watcher = createTreasuryWatcher({ client: fakeClient(balances), intervalMs: 1000 });
    await watcher.pollOnce();
    await watcher.pollOnce(); // confirms baseline 100
    const baseCredits = findUserBySuiAddress(SUI_USER)?.credits ?? 0;

    balances["0xdep_1"] = [{ coinType: USDC, totalBalance: "20" }]; // sweep
    await watcher.pollOnce(); // pending(20)
    const sweepStats = await watcher.pollOnce(); // confirmed sweep
    expect(sweepStats.newDeposits).toBe(0);
    expect(sweepStats.creditsGrantedTotal).toBe(0);
    expect(findUserBySuiAddress(SUI_USER)?.credits).toBe(baseCredits);
    expect(getAddressBalance("0xdep_1", canonicalType(USDC))?.lastSeenBalance).toBe(20n);

    // A poll at the swept (already-confirmed) baseline is a pure noop.
    const noop = await watcher.pollOnce();
    expect(noop.newDeposits).toBe(0);

    balances["0xdep_1"] = [{ coinType: USDC, totalBalance: "70" }]; // later deposit
    await watcher.pollOnce(); // pending(70)
    const depositStats = await watcher.pollOnce(); // confirmed: delta +50
    expect(depositStats.newDeposits).toBe(1);
    expect(depositStats.creditsGrantedTotal).toBe(50);
    expect(findUserBySuiAddress(SUI_USER)?.credits).toBe(baseCredits + 50);
  });

  it("a different intermediate value resets the pending counter (never confirms without 2 matching polls)", async () => {
    seedUnitRate();
    const balances = { "0xdep_1": [{ coinType: USDC, totalBalance: "100" }] };
    const watcher = createTreasuryWatcher({ client: fakeClient(balances), intervalMs: 1000 });
    await watcher.pollOnce();
    await watcher.pollOnce(); // confirms baseline 100

    balances["0xdep_1"] = [{ coinType: USDC, totalBalance: "40" }];
    await watcher.pollOnce(); // pending(40) count=1
    balances["0xdep_1"] = [{ coinType: USDC, totalBalance: "60" }];
    await watcher.pollOnce(); // differs from pending(40) -> reset pending(60) count=1
    balances["0xdep_1"] = [{ coinType: USDC, totalBalance: "100" }];
    const stats = await watcher.pollOnce(); // back to baseline -> clears pending, no action
    expect(stats.newDeposits).toBe(0);
    expect(stats.creditsGrantedTotal).toBe(0);
    expect(getAddressBalance("0xdep_1", canonicalType(USDC))?.lastSeenBalance).toBe(100n);
  });
});

describe("watcher — unregistered rate path", () => {
  it("deposit with no credit rate: row recorded with credits=0 once confirmed", async () => {
    registerUserTx(SUI_USER, () => "0xdep_1");
    // no upsertCreditRate
    const watcher = createTreasuryWatcher({
      client: fakeClient({
        "0xdep_1": [{ coinType: "0xfeed::TOKEN::TOKEN", totalBalance: "9999999" }],
      }),
      intervalMs: 1000,
    });
    await watcher.pollOnce(); // pending
    const stats = await watcher.pollOnce(); // confirmed
    expect(stats.newDeposits).toBe(1);
    expect(stats.creditsGrantedTotal).toBe(0);
    expect(findUserBySuiAddress(SUI_USER)?.credits).toBe(0);
    const dep = listDepositsForUser(SUI_USER, 10);
    expect(dep[0]?.creditsGranted).toBe(0);
    expect(dep[0]?.rateNum).toBeNull();
  });
});

describe("watcher — error isolation", () => {
  it("a failing user does not block other users in the same tick", async () => {
    seed();
    registerUserTx("0xuser_b", () => "0xdep_2");
    const watcher = createTreasuryWatcher({
      client: {
        async getAllBalances({ owner }) {
          if (owner === "0xdep_1") throw new Error("RPC down");
          return [{ coinType: USDC, totalBalance: "3000000" }];
        },
      },
      intervalMs: 1000,
    });
    await watcher.pollOnce(); // pending for user_b
    const stats = await watcher.pollOnce(); // confirms for user_b
    expect(stats.errors).toBe(1);
    expect(stats.usersScanned).toBe(2);
    // user_a got nothing (RPC failed), user_b got 300 credits.
    expect(findUserBySuiAddress(SUI_USER)?.credits).toBe(0);
    expect(findUserBySuiAddress("0xuser_b")?.credits).toBe(300);
  });
});

describe("watcher — empty cohort", () => {
  it("noop with stats=0 when no users are registered", async () => {
    const watcher = createTreasuryWatcher({
      client: fakeClient({}),
      intervalMs: 1000,
    });
    const stats = await watcher.pollOnce();
    expect(stats.usersScanned).toBe(0);
    expect(stats.newDeposits).toBe(0);
  });
});
