/**
 * tests/decision/lotStore.test.ts — lot persistence + carry-forward.
 *
 * The critical property: a full rebuild (diffPlan removes everything and
 * re-adds) must NOT reset lot age, or the 4h/12h stop-loss thresholds could
 * never fire while the bot rebalances more often than 4h (i.e. always).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadOpenLots, syncLotsAfterRebalance } from "../../src/decision/lotStore.ts";
import type { RebalancePlan } from "../../src/domain/types.ts";

const PM_ID = "0xpm";
const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;

function openTestDb(): Database {
  const db = new Database(":memory:");
  const here = dirname(fileURLToPath(import.meta.url));
  db.exec(readFileSync(resolve(here, "../../src/db/schema.sql"), "utf8"));
  return db;
}

function makePlan(opts: {
  bins: number[];
  amountsA: bigint[];
  amountsB: bigint[];
}): RebalancePlan {
  return {
    pmId: PM_ID,
    removeShares: new Map(),
    addAmountA: opts.amountsA.reduce((s, v) => s + v, 0n),
    addAmountB: opts.amountsB.reduce((s, v) => s + v, 0n),
    addBins: opts.bins,
    addAmountsA: opts.amountsA,
    addAmountsB: opts.amountsB,
    collectFees: false,
    reason: "test",
  };
}

let db: Database;
beforeEach(() => {
  db = openTestDb();
});

describe("syncLotsAfterRebalance", () => {
  it("first deploy creates fresh lots stamped at now, at the side's largest bin", () => {
    const plan = makePlan({
      bins: [98, 99, 101, 102],
      amountsA: [0n, 0n, 300n, 700n],
      amountsB: [400n, 600n, 0n, 0n],
    });
    syncLotsAfterRebalance(db, PM_ID, plan, 2.5, T0);

    const lots = loadOpenLots(db, PM_ID);
    expect(lots).toHaveLength(2);
    const a = lots.find((l) => l.side === "A")!;
    const b = lots.find((l) => l.side === "B")!;
    expect(a.amount).toBe(1_000n);
    expect(a.binId).toBe(102); // largest A amount
    expect(a.acquiredAtMs).toBe(T0);
    expect(a.costBasis).toBe(2.5);
    expect(b.amount).toBe(1_000n);
    expect(b.binId).toBe(99); // largest B amount
  });

  it("carry-forward across a full rebuild preserves the EARLIEST age and weighted cost", () => {
    // T0: initial lots.
    syncLotsAfterRebalance(
      db, PM_ID,
      makePlan({ bins: [101], amountsA: [1_000n], amountsB: [0n] }),
      2.0, T0,
    );
    // T0+1h: full rebuild re-adds the same amount at new bins.
    syncLotsAfterRebalance(
      db, PM_ID,
      makePlan({ bins: [105], amountsA: [1_000n], amountsB: [0n] }),
      3.0, T0 + HOUR,
    );

    const lots = loadOpenLots(db, PM_ID);
    expect(lots).toHaveLength(1);
    // Age NOT reset; cost basis carried; re-parked at the new bin.
    expect(lots[0]!.acquiredAtMs).toBe(T0);
    expect(lots[0]!.costBasis).toBe(2.0);
    expect(lots[0]!.binId).toBe(105);
  });

  it("excess re-add becomes a NEW lot at now/spot; carried part keeps its age", () => {
    syncLotsAfterRebalance(
      db, PM_ID,
      makePlan({ bins: [101], amountsA: [1_000n], amountsB: [0n] }),
      2.0, T0,
    );
    // Re-add 1_500: 1_000 carried + 500 fresh.
    syncLotsAfterRebalance(
      db, PM_ID,
      makePlan({ bins: [103], amountsA: [1_500n], amountsB: [0n] }),
      4.0, T0 + HOUR,
    );

    const lots = loadOpenLots(db, PM_ID).filter((l) => l.side === "A");
    expect(lots).toHaveLength(2);
    const carried = lots.find((l) => l.acquiredAtMs === T0)!;
    const fresh = lots.find((l) => l.acquiredAtMs === T0 + HOUR)!;
    expect(carried.amount).toBe(1_000n);
    expect(carried.costBasis).toBe(2.0);
    expect(fresh.amount).toBe(500n);
    expect(fresh.costBasis).toBe(4.0);
  });

  it("shrunk re-add carries only the re-added amount (value-weighted cost)", () => {
    // Two prior lots on side A: 1_000@2.0 (old) + 1_000@4.0 (newer).
    syncLotsAfterRebalance(
      db, PM_ID,
      makePlan({ bins: [101], amountsA: [1_000n], amountsB: [0n] }),
      2.0, T0,
    );
    syncLotsAfterRebalance(
      db, PM_ID,
      makePlan({ bins: [101], amountsA: [2_000n], amountsB: [0n] }),
      4.0, T0 + HOUR,
    );
    // Rebuild re-adds only 600.
    syncLotsAfterRebalance(
      db, PM_ID,
      makePlan({ bins: [102], amountsA: [600n], amountsB: [0n] }),
      5.0, T0 + 2 * HOUR,
    );

    const lots = loadOpenLots(db, PM_ID).filter((l) => l.side === "A");
    expect(lots).toHaveLength(1);
    expect(lots[0]!.amount).toBe(600n);
    expect(lots[0]!.acquiredAtMs).toBe(T0); // earliest age survives
    expect(lots[0]!.costBasis).toBeCloseTo(3.0, 10); // (1000×2 + 1000×4) / 2000
  });

  it("a side that re-adds nothing closes out", () => {
    syncLotsAfterRebalance(
      db, PM_ID,
      makePlan({ bins: [99, 101], amountsA: [0n, 500n], amountsB: [500n, 0n] }),
      2.0, T0,
    );
    // Rebuild deploys only side B.
    syncLotsAfterRebalance(
      db, PM_ID,
      makePlan({ bins: [99], amountsA: [0n], amountsB: [500n] }),
      2.0, T0 + HOUR,
    );

    const lots = loadOpenLots(db, PM_ID);
    expect(lots).toHaveLength(1);
    expect(lots[0]!.side).toBe("B");
  });

  it("PMs are isolated", () => {
    syncLotsAfterRebalance(
      db, PM_ID,
      makePlan({ bins: [101], amountsA: [100n], amountsB: [0n] }),
      2.0, T0,
    );
    expect(loadOpenLots(db, "0xother")).toHaveLength(0);
  });
});
