/**
 * Tests for src/treasury/backfill.ts — backfillCredits().
 *
 * Spec reference: docs/treasury-role-design.md §6.1 "handling deposits received before a credit rate is configured"
 *
 * Cases covered:
 *   1. Deposits with no rate (rate_num IS NULL) → rate set → backfill grants exact
 *      floor(amount × num / den) and bumps user credits.
 *   2. Re-running backfill is a strict no-op (idempotent): processed=0.
 *   3. Dust rows that had a rate at deposit time (rate_num IS NOT NULL,
 *      credits_granted=0) are NOT touched by backfill.
 *   4. Rate not yet set → loud error (no silent fallback).
 *   5. Canonical vs short-form coin type hit the same rate row.
 *   6. Multiple users under the same coin type are all backfilled in one call.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, resetDbCacheForTests } from "../../src/db/client.ts";
import {
  findUserBySuiAddress,
  getCreditRate,
  recordDepositTx,
  registerUserTx,
  upsertCreditRate,
} from "../../src/treasury/store.ts";
import { backfillCredits } from "../../src/treasury/backfill.ts";
import { canonicalType } from "../../src/sui/lending/typeNorm.ts";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const USDC_RAW = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
// Short-form representation that normalises to the same canonical string.
const USDC_SHORT = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const USDC = canonicalType(USDC_RAW);

const USER_A = "0x" + "a".repeat(64);
const USER_B = "0x" + "b".repeat(64);

// ---------------------------------------------------------------------------
// DB lifecycle
// ---------------------------------------------------------------------------

let tmpDir: string;

function freshDb(): void {
  resetDbCacheForTests();
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDir = mkdtempSync(join(tmpdir(), "treasury-backfill-"));
  openDb(join(tmpDir, "test.db"));
}

beforeEach(() => freshDb());

afterAll(() => {
  resetDbCacheForTests();
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

let depSeq = 0;

function nextDepId(): string {
  depSeq += 1;
  return `dep_${depSeq}`;
}

/** Seed a deposit row with no rate (watcher behaviour when coin has no rate). */
function seedNullRateDeposit(
  suiAddress: string,
  depositAddress: string,
  amountDelta: bigint,
): void {
  recordDepositTx({
    id: nextDepId(),
    suiAddress,
    depositAddress,
    coinType: USDC,
    amountDelta,
    prevBalance: 0n,
    newBalance: amountDelta,
    creditsGranted: 0,
    rateNum: null,
    rateDen: null,
    observedAtMs: Date.now(),
  });
}

/** Seed a deposit row WITH a rate (dust or normal — rate_num is set). */
function seedRatedDeposit(
  suiAddress: string,
  depositAddress: string,
  amountDelta: bigint,
  creditsGranted: number,
  rateNum: bigint,
  rateDen: bigint,
): void {
  recordDepositTx({
    id: nextDepId(),
    suiAddress,
    depositAddress,
    coinType: USDC,
    amountDelta,
    prevBalance: 0n,
    newBalance: amountDelta,
    creditsGranted,
    rateNum,
    rateDen,
    observedAtMs: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("backfillCredits — basic grant", () => {
  it("grants floor(amount × num / den) credits for each NULL-rate deposit row", () => {
    registerUserTx(USER_A, (i) => `0xdep_${i}`);
    // Simulate watcher recording 5 USDC with no rate at the time.
    seedNullRateDeposit(USER_A, "0xdep_1", 5_000_000n);

    // User has 0 credits until the backfill.
    expect(findUserBySuiAddress(USER_A)?.credits).toBe(0);

    // Operator sets the rate: 1 credit = 0.01 USDC = 10_000 atomic.
    upsertCreditRate({ coinType: USDC, rateNum: 1n, rateDen: 10_000n });

    const result = backfillCredits(USDC);

    expect(result.processed).toBe(1);
    // floor(5_000_000 × 1 / 10_000) = 500
    expect(result.creditsGranted).toBe(500);
    expect(result.skipped).toBe(0);
    expect(findUserBySuiAddress(USER_A)?.credits).toBe(500);
  });

  it("applies bigint floor correctly — 9999 atomic yields 0 credits, 10001 yields 1", () => {
    registerUserTx(USER_A, (i) => `0xdep_${i}`);
    // Two deposits: one dust (rounds to 0), one just-above-threshold.
    seedNullRateDeposit(USER_A, "0xdep_1", 9_999n);
    seedNullRateDeposit(USER_A, "0xdep_1", 10_001n);

    upsertCreditRate({ coinType: USDC, rateNum: 1n, rateDen: 10_000n });
    const result = backfillCredits(USDC);

    expect(result.processed).toBe(2);
    // 9999 → 0; 10001 → 1
    expect(result.creditsGranted).toBe(1);
    expect(findUserBySuiAddress(USER_A)?.credits).toBe(1);
  });

  it("processes multiple users in a single call", () => {
    registerUserTx(USER_A, (i) => `0xdep_a_${i}`);
    registerUserTx(USER_B, (i) => `0xdep_b_${i}`);

    seedNullRateDeposit(USER_A, "0xdep_a_1", 1_000_000n); // 100 credits
    seedNullRateDeposit(USER_B, "0xdep_b_2", 2_000_000n); // 200 credits

    upsertCreditRate({ coinType: USDC, rateNum: 1n, rateDen: 10_000n });
    const result = backfillCredits(USDC);

    expect(result.processed).toBe(2);
    expect(result.creditsGranted).toBe(300);
    expect(findUserBySuiAddress(USER_A)?.credits).toBe(100);
    expect(findUserBySuiAddress(USER_B)?.credits).toBe(200);
  });
});

describe("backfillCredits — idempotency", () => {
  it("re-running after backfill processes nothing (processed=0)", () => {
    registerUserTx(USER_A, (i) => `0xdep_${i}`);
    seedNullRateDeposit(USER_A, "0xdep_1", 5_000_000n);
    upsertCreditRate({ coinType: USDC, rateNum: 1n, rateDen: 10_000n });

    const first = backfillCredits(USDC);
    expect(first.processed).toBe(1);
    expect(first.creditsGranted).toBe(500);

    // Re-run: all rows now have rate_num set → nothing to do.
    const second = backfillCredits(USDC);
    expect(second.processed).toBe(0);
    expect(second.creditsGranted).toBe(0);

    // Credits must not be double-granted.
    expect(findUserBySuiAddress(USER_A)?.credits).toBe(500);
  });

  it("skipped count reflects rows that already had a rate at deposit time", () => {
    registerUserTx(USER_A, (i) => `0xdep_${i}`);
    upsertCreditRate({ coinType: USDC, rateNum: 1n, rateDen: 10_000n });

    // One deposit with rate set at the time (normal watcher behaviour after rate exists):
    seedRatedDeposit(USER_A, "0xdep_1", 5_000_000n, 500, 1n, 10_000n);
    // One NULL-rate deposit (watcher before rate was set):
    seedNullRateDeposit(USER_A, "0xdep_1", 2_000_000n);

    // User already has 500 from the rated deposit.
    expect(findUserBySuiAddress(USER_A)?.credits).toBe(500);

    const result = backfillCredits(USDC);
    expect(result.processed).toBe(1);        // only the NULL-rate row
    expect(result.creditsGranted).toBe(200); // floor(2e6 / 1e4)
    expect(result.skipped).toBe(1);          // the already-rated row

    // No double-grant on the already-rated row.
    expect(findUserBySuiAddress(USER_A)?.credits).toBe(700);
  });
});

describe("backfillCredits — dust rows NOT re-processed", () => {
  it("a deposit with rate set but credits_granted=0 (dust) is ignored by backfill", () => {
    registerUserTx(USER_A, (i) => `0xdep_${i}`);
    upsertCreditRate({ coinType: USDC, rateNum: 1n, rateDen: 10_000n });

    // Deposit of 9999 atomic → floor(9999/10000) = 0 credits. Rate IS set on the row.
    seedRatedDeposit(USER_A, "0xdep_1", 9_999n, 0, 1n, 10_000n);

    expect(findUserBySuiAddress(USER_A)?.credits).toBe(0);

    const result = backfillCredits(USDC);
    // The row had rate_num set → it is counted as skipped, not processed.
    expect(result.processed).toBe(0);
    expect(result.creditsGranted).toBe(0);
    expect(result.skipped).toBe(1);
    // Credits must remain 0 — this was a correct dust grant at deposit time.
    expect(findUserBySuiAddress(USER_A)?.credits).toBe(0);
  });
});

describe("backfillCredits — rate not set", () => {
  it("throws a descriptive error when no rate exists for the coin type", () => {
    registerUserTx(USER_A, (i) => `0xdep_${i}`);
    seedNullRateDeposit(USER_A, "0xdep_1", 5_000_000n);
    // No upsertCreditRate — rate is unset.

    expect(() => backfillCredits(USDC)).toThrow(/no credit rate found/);
  });

  it("error message names the coin type", () => {
    expect(() => backfillCredits(USDC)).toThrow(USDC);
  });
});

describe("backfillCredits — coin type normalisation", () => {
  it("canonical and short-form inputs resolve to the same rate row", () => {
    registerUserTx(USER_A, (i) => `0xdep_${i}`);
    seedNullRateDeposit(USER_A, "0xdep_1", 1_000_000n);

    // Rate is stored under the canonical form (as upsertCreditRate callers must do).
    upsertCreditRate({ coinType: canonicalType(USDC_RAW), rateNum: 1n, rateDen: 10_000n });

    // backfillCredits(short form) must find the same rate.
    const result = backfillCredits(USDC_SHORT);
    expect(result.processed).toBe(1);
    expect(result.creditsGranted).toBe(100);
    expect(getCreditRate(canonicalType(USDC_SHORT))).not.toBeNull();
  });

  it("deposits stored under canonical form are found when backfill is called with the canonical form", () => {
    registerUserTx(USER_A, (i) => `0xdep_${i}`);
    seedNullRateDeposit(USER_A, "0xdep_1", 500_000n);

    upsertCreditRate({ coinType: USDC, rateNum: 1n, rateDen: 10_000n });
    // Calling with the already-canonical form.
    const result = backfillCredits(USDC);
    expect(result.processed).toBe(1);
    expect(result.creditsGranted).toBe(50);
  });
});

describe("backfillCredits — no deposits", () => {
  it("returns processed=0 and skipped=0 when there are no deposits at all for the coin", () => {
    upsertCreditRate({ coinType: USDC, rateNum: 1n, rateDen: 10_000n });
    const result = backfillCredits(USDC);
    expect(result.processed).toBe(0);
    expect(result.creditsGranted).toBe(0);
    expect(result.skipped).toBe(0);
  });
});
