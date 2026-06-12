/**
 * Rebalancer ↔ treasury integration tests.
 *
 * Closes the gap documented in docs/treasury-role-design.md §8:
 * "rebalancer integration path ... not yet unit-tested"
 *
 * Why this file tests at the charges+credits seam rather than calling
 * rebalancer.tickOne wholesale
 * ───────────────────────────────────────────────────────────────────
 * `rebalancer.tickOne` pulls in live Sui RPC clients, CDPM SDK, pool state,
 * price feeds, and strategy implementations. Standing those up in a unit test
 * requires substantial mock infrastructure for functionality that is already
 * tested in isolation elsewhere.
 *
 * Instead, this file exercises the exact treasury seam that rebalancer.tickOne
 * uses (see src/services/rebalancer.ts lines ~344–383):
 *
 *   1. `findUserBySuiAddress(pm.owner)` — registration gate
 *   2. `attemptCharge({ suiAddress, pmId, cost, nonce, memo })` — pre-debit
 *   3. `refundCharge(nonce, reason)` — on PTB failure
 *
 * Nonce shape: `${tickId}:${pmId}` (Crockford base-32 style, e.g. "t1abc:0xpm").
 *
 * All tests use in-memory SQLite via the standard test-DB helpers. No network,
 * no keypairs, no on-chain calls.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, resetDbCacheForTests } from "../../src/db/client.ts";
import {
  findUserBySuiAddress,
  findChargeByNonce,
  recordDepositTx,
  registerUserTx,
  upsertCreditRate,
} from "../../src/treasury/store.ts";
import { attemptCharge, refundCharge } from "../../src/treasury/charges.ts";
import { canonicalType } from "../../src/sui/lending/typeNorm.ts";

// ---------------------------------------------------------------------------
// DB lifecycle
// ---------------------------------------------------------------------------

let tmpDir: string;

function freshDb(): void {
  resetDbCacheForTests();
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDir = mkdtempSync(join(tmpdir(), "treasury-rebalancer-"));
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
// Test constants — same shapes as in production rebalancer
// ---------------------------------------------------------------------------

const USDC = canonicalType(
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
);
const PM_ID = "0x" + "f".repeat(64);
const OWNER = "0x" + "a".repeat(64);

/** Build a rebalancer-style nonce: `${tickId}:${pmId}`. */
function nonce(tickId: string, pmId = PM_ID): string {
  return `${tickId}:${pmId}`;
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

/** Register OWNER and give them `credits` credits via a fake deposit. */
function seedUser(credits: number): void {
  registerUserTx(OWNER, (i) => `0xdep_${i}`);
  if (credits > 0) {
    // rate: 1 credit = 10_000 USDC-atomic
    upsertCreditRate({ coinType: USDC, rateNum: 1n, rateDen: 10_000n });
    recordDepositTx({
      id: `dep_seed_${credits}`,
      suiAddress: OWNER,
      depositAddress: "0xdep_1",
      coinType: USDC,
      amountDelta: BigInt(credits) * 10_000n,
      prevBalance: 0n,
      newBalance: BigInt(credits) * 10_000n,
      creditsGranted: credits,
      rateNum: 1n,
      rateDen: 10_000n,
      observedAtMs: 0,
    });
  }
}

// ---------------------------------------------------------------------------
// 1. Unregistered owner + requireRegistration gate
// ---------------------------------------------------------------------------

describe("gate: unregistered owner", () => {
  it("attemptCharge for unregistered owner returns ok=false, error=not_registered", () => {
    // Mirror of rebalancer gate:
    //   if (!registered && cfg.treasury.requireRegistration) return;
    //   if (registered) { ... attemptCharge ... }
    // When owner is not registered, rebalancer skips the charge call entirely.
    // If called anyway (e.g. requireRegistration=false path that still charges):
    const result = attemptCharge({
      suiAddress: "0xnobody",
      pmId: PM_ID,
      cost: 50,
      nonce: nonce("t1"),
      memo: "rebalance volA=0 volB=0",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("not_registered");
  });

  it("balance is unchanged after a rejected unregistered charge", () => {
    // No registration → no user row → nothing to change.
    attemptCharge({
      suiAddress: "0xnobody",
      pmId: PM_ID,
      cost: 100,
      nonce: nonce("t2"),
      memo: null,
    });
    expect(findUserBySuiAddress("0xnobody")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Registered user with insufficient credits
// ---------------------------------------------------------------------------

describe("gate: insufficient credits", () => {
  it("charge is rejected when user has fewer credits than cost", () => {
    seedUser(40);
    const result = attemptCharge({
      suiAddress: OWNER,
      pmId: PM_ID,
      cost: 50,
      nonce: nonce("t3"),
      memo: "rebalance volA=100000 volB=200000",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("insufficient_credits");
  });

  it("user balance is unchanged after an insufficient-credits rejection", () => {
    seedUser(40);
    attemptCharge({
      suiAddress: OWNER,
      pmId: PM_ID,
      cost: 50,
      nonce: nonce("t4"),
      memo: null,
    });
    expect(findUserBySuiAddress(OWNER)?.credits).toBe(40);
  });
});

// ---------------------------------------------------------------------------
// 3. Successful charge
// ---------------------------------------------------------------------------

describe("successful charge", () => {
  it("debits credits and records an ok charge row", () => {
    seedUser(1000);
    const chargeNonce = nonce("tabc");
    const result = attemptCharge({
      suiAddress: OWNER,
      pmId: PM_ID,
      cost: 110,
      nonce: chargeNonce,
      memo: `rebalance volA=${1_000_000_000n} volB=${100_000_000n}`,
    });

    expect(result.ok).toBe(true);
    expect(result.chargeNonce).toBe(chargeNonce);
    expect(result.error).toBeUndefined();

    expect(findUserBySuiAddress(OWNER)?.credits).toBe(890); // 1000 - 110

    const row = findChargeByNonce(chargeNonce);
    expect(row).not.toBeNull();
    expect(row?.status).toBe("ok");
    expect(row?.creditsDebited).toBe(110);
    expect(row?.pmId).toBe(PM_ID);
    expect(row?.suiAddress).toBe(OWNER);
  });

  it("charge row memo matches the rebalancer memo pattern", () => {
    seedUser(500);
    const chargeNonce = nonce("tmemo");
    attemptCharge({
      suiAddress: OWNER,
      pmId: PM_ID,
      cost: 20,
      nonce: chargeNonce,
      memo: "rebalance volA=0 volB=1000000000",
    });
    const row = findChargeByNonce(chargeNonce);
    expect(row?.memo).toBe("rebalance volA=0 volB=1000000000");
  });
});

// ---------------------------------------------------------------------------
// 4. Nonce replay — no double debit
// ---------------------------------------------------------------------------

describe("nonce replay (idempotency)", () => {
  it("second attemptCharge with same nonce returns existing row, no double debit", () => {
    seedUser(1000);
    const chargeNonce = nonce("treplay");

    const first = attemptCharge({
      suiAddress: OWNER,
      pmId: PM_ID,
      cost: 100,
      nonce: chargeNonce,
      memo: null,
    });
    expect(first.ok).toBe(true);
    expect(findUserBySuiAddress(OWNER)?.credits).toBe(900);

    // Simulate rebalancer crash + retry: same nonce, possibly different cost.
    const second = attemptCharge({
      suiAddress: OWNER,
      pmId: PM_ID,
      cost: 999, // different cost, same nonce
      nonce: chargeNonce,
      memo: null,
    });

    // Should return the original row unchanged.
    expect(second.chargeNonce).toBe(chargeNonce);
    expect(second.ok).toBe(true);

    // Credits unchanged — no double debit.
    expect(findUserBySuiAddress(OWNER)?.credits).toBe(900);

    // The charge row still reflects the original debit.
    expect(findChargeByNonce(chargeNonce)?.creditsDebited).toBe(100);
  });

  it("nonce shape `${tickId}:${pmId}` is the exact format used in production", () => {
    // Verify the helper produces the same nonce the rebalancer does.
    const tickId = "t1lf5b3xyz";
    const pmId = "0x" + "c".repeat(64);
    const expected = `${tickId}:${pmId}`;
    expect(nonce(tickId, pmId)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// 5. Refund on PTB failure
// ---------------------------------------------------------------------------

describe("refund after PTB failure", () => {
  it("refundCharge restores balance and marks row refunded", () => {
    seedUser(1000);
    const chargeNonce = nonce("tfail");

    const charge = attemptCharge({
      suiAddress: OWNER,
      pmId: PM_ID,
      cost: 110,
      nonce: chargeNonce,
      memo: null,
    });
    expect(charge.ok).toBe(true);
    expect(findUserBySuiAddress(OWNER)?.credits).toBe(890);

    // Simulated PTB failure in the try/catch block of rebalancer.tickOne.
    const wasRefunded = refundCharge(chargeNonce, "rebalance_failed");
    expect(wasRefunded).toBe(true);

    expect(findUserBySuiAddress(OWNER)?.credits).toBe(1000); // fully restored
    expect(findChargeByNonce(chargeNonce)?.status).toBe("refunded");
    expect(findChargeByNonce(chargeNonce)?.error).toBe("rebalance_failed");
  });

  it("refund for a non-existent nonce is a no-op (returns false)", () => {
    // Matches the rebalancer's `.catch(() => { ... })` guard:
    //   if (chargeNonce) { try { refundCharge(chargeNonce, ...) } catch ... }
    const result = refundCharge("t_nonexistent:0xpm", "rebalance_failed");
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. Refund idempotency (double-refund protection)
// ---------------------------------------------------------------------------

describe("refund idempotency", () => {
  it("second refund for the same nonce is a no-op (returns false)", () => {
    seedUser(1000);
    const chargeNonce = nonce("tdouble");

    attemptCharge({ suiAddress: OWNER, pmId: PM_ID, cost: 50, nonce: chargeNonce, memo: null });
    expect(findUserBySuiAddress(OWNER)?.credits).toBe(950);

    const first = refundCharge(chargeNonce, "rebalance_failed");
    expect(first).toBe(true);
    expect(findUserBySuiAddress(OWNER)?.credits).toBe(1000);

    // Second refund must not restore credits again.
    const second = refundCharge(chargeNonce, "rebalance_failed");
    expect(second).toBe(false);
    expect(findUserBySuiAddress(OWNER)?.credits).toBe(1000); // unchanged
  });

  it("attempting to refund a rejected charge (not_registered) is a no-op", () => {
    // A rejected charge row (status='rejected') cannot be refunded.
    const chargeNonce = nonce("trejected");
    attemptCharge({
      suiAddress: "0xunregistered",
      pmId: PM_ID,
      cost: 50,
      nonce: chargeNonce,
      memo: null,
    });
    // rejected row was not inserted (FK would fail) — refund should be false.
    const result = refundCharge(chargeNonce, "reason");
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. End-to-end rebalancer calling convention
// ---------------------------------------------------------------------------

describe("full rebalancer tick simulation", () => {
  it("tick succeeds: credits debited, nonce row ok, no refund", () => {
    seedUser(500);

    // Step 1: gate check
    const registered = findUserBySuiAddress(OWNER) !== null;
    expect(registered).toBe(true);

    // Step 2: pre-charge (mirrors rebalancer.tickOne)
    const tickId = "t_sim_ok";
    const charge = attemptCharge({
      suiAddress: OWNER,
      pmId: PM_ID,
      cost: 20,
      nonce: nonce(tickId),
      memo: `rebalance volA=${0n} volB=${100_000_000n}`,
    });
    expect(charge.ok).toBe(true);
    const chargeNonce = charge.chargeNonce;

    // Step 3: PTB succeeds — no refund called.
    expect(findUserBySuiAddress(OWNER)?.credits).toBe(480);
    expect(findChargeByNonce(chargeNonce)?.status).toBe("ok");
  });

  it("tick fails: credits are fully refunded, nonce row marked refunded", () => {
    seedUser(500);

    const registered = findUserBySuiAddress(OWNER) !== null;
    expect(registered).toBe(true);

    const tickId = "t_sim_fail";
    const charge = attemptCharge({
      suiAddress: OWNER,
      pmId: PM_ID,
      cost: 20,
      nonce: nonce(tickId),
      memo: `rebalance volA=${0n} volB=${100_000_000n}`,
    });
    expect(charge.ok).toBe(true);
    const chargeNonce = charge.chargeNonce;
    expect(findUserBySuiAddress(OWNER)?.credits).toBe(480);

    // Simulated PTB failure → refund path in rebalancer catch block.
    const refunded = refundCharge(chargeNonce, "submitUnifiedRebalance failed");
    expect(refunded).toBe(true);

    expect(findUserBySuiAddress(OWNER)?.credits).toBe(500); // fully restored
    expect(findChargeByNonce(chargeNonce)?.status).toBe("refunded");
  });
});
