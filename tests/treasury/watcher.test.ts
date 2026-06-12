/**
 * Tests for src/treasury/watcher.ts — delta math + idempotency + error isolation.
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

describe("watcher — delta > 0 path", () => {
  it("first observation: inserts deposit row, credits user, populates cache", async () => {
    seed();
    const watcher = createTreasuryWatcher({
      client: fakeClient({ "0xdep_1": [{ coinType: USDC, totalBalance: "5000000" }] }),
      intervalMs: 1000,
    });
    const stats = await watcher.pollOnce();
    expect(stats.newDeposits).toBe(1);
    expect(stats.creditsGrantedTotal).toBe(500); // 5e6 × 1 / 1e4
    expect(stats.errors).toBe(0);
    expect(findUserBySuiAddress(SUI_USER)?.credits).toBe(500);
    expect(getAddressBalance("0xdep_1", canonicalType(USDC))?.lastSeenBalance).toBe(5_000_000n);
  });

  it("subsequent tick with same balance is a noop (no new deposits)", async () => {
    seed();
    const watcher = createTreasuryWatcher({
      client: fakeClient({ "0xdep_1": [{ coinType: USDC, totalBalance: "5000000" }] }),
      intervalMs: 1000,
    });
    await watcher.pollOnce();
    const second = await watcher.pollOnce();
    expect(second.newDeposits).toBe(0);
    expect(second.creditsGrantedTotal).toBe(0);
    expect(findUserBySuiAddress(SUI_USER)?.credits).toBe(500);
  });

  it("incremental delta only credits the delta", async () => {
    seed();
    const balances = { "0xdep_1": [{ coinType: USDC, totalBalance: "5000000" }] };
    const watcher = createTreasuryWatcher({
      client: fakeClient(balances),
      intervalMs: 1000,
    });
    await watcher.pollOnce();
    balances["0xdep_1"] = [{ coinType: USDC, totalBalance: "7500000" }]; // +2.5e6
    const stats = await watcher.pollOnce();
    expect(stats.newDeposits).toBe(1);
    expect(stats.creditsGrantedTotal).toBe(250); // 2.5e6 × 1 / 1e4
    expect(findUserBySuiAddress(SUI_USER)?.credits).toBe(750);
  });
});

describe("watcher — delta < 0 path", () => {
  it("outflow updates cache but does NOT reduce credits", async () => {
    seed();
    const balances = { "0xdep_1": [{ coinType: USDC, totalBalance: "5000000" }] };
    const watcher = createTreasuryWatcher({
      client: fakeClient(balances),
      intervalMs: 1000,
    });
    await watcher.pollOnce();
    balances["0xdep_1"] = [{ coinType: USDC, totalBalance: "1000000" }]; // operator sweep
    const stats = await watcher.pollOnce();
    expect(stats.newDeposits).toBe(0);
    expect(stats.creditsGrantedTotal).toBe(0);
    expect(findUserBySuiAddress(SUI_USER)?.credits).toBe(500);
    expect(getAddressBalance("0xdep_1", canonicalType(USDC))?.lastSeenBalance).toBe(1_000_000n);
  });
});

describe("watcher — unregistered rate path", () => {
  it("deposit with no credit rate: row recorded with credits=0", async () => {
    registerUserTx(SUI_USER, () => "0xdep_1");
    // no upsertCreditRate
    const watcher = createTreasuryWatcher({
      client: fakeClient({
        "0xdep_1": [{ coinType: "0xfeed::TOKEN::TOKEN", totalBalance: "9999999" }],
      }),
      intervalMs: 1000,
    });
    const stats = await watcher.pollOnce();
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
    const stats = await watcher.pollOnce();
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
