/**
 * tests/data/cetusEvents.test.ts
 *
 * Tests for createCetusEventsFeed and backfillSwapEvents.
 * Uses injected fake clients — no real RPC calls.
 * No SQLite (DB not initialized in tests).
 */

import { describe, it, expect } from "bun:test";
import {
  createCetusEventsFeed,
  backfillSwapEvents,
} from "../../src/data/feeds/cetusEvents.ts";
import type { SwapEventRecord } from "../../src/data/feeds/cetusEvents.ts";
import type { SuiEvent } from "@mysten/sui/jsonRpc";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const POOL_ID = "0xpool123";
const DLMM_PACKAGE = "0x5664f9d3fd82c84023870cfbda8ea84e14c8dd56ce557ad2116e0668581a682b";
const BIN_STEP = 10;

// SUI/USDC mainnet pool physical orientation: coinA=USDC(6), coinB=SUI(9).
// Tests default to these unless overridden.
const POOL_COIN_A_DECIMALS = 6;
const POOL_COIN_B_DECIMALS = 9;

/** Build a minimal SuiEvent representing a SwapEvent for the given pool / binId. */
function makeSwapEvent(
  binId: number,
  timestampMs: number,
  txDigest: string,
  eventSeq: string,
  poolId: string = POOL_ID,
): SuiEvent {
  // Encode signed I32 as u32 bits (Cetus format).
  const bits = binId < 0 ? binId + 0x100000000 : binId;
  return {
    id: { txDigest, eventSeq },
    type: `${DLMM_PACKAGE}::pool::SwapEvent`,
    packageId: DLMM_PACKAGE,
    transactionModule: "pool",
    sender: "0xsender",
    parsedJson: {
      pool: poolId,
      amount_in: "1000000",
      amount_out: "999000",
      fee: "1000",
      ref_fee: "0",
      bin_swaps: [
        {
          bin_id: { bits },
          amount_in: "1000000",
          amount_out: "999000",
          fee: "1000",
          var_fee_rate: "0",
        },
      ],
      from: { name: "A" },
      target: { name: "B" },
      partner: "0xpartner",
    },
    timestampMs: String(timestampMs),
    bcs: "",
  } as unknown as SuiEvent;
}

/**
 * Build a fake pool object response matching the REAL on-chain field layout:
 *   fields.active_id = { fields: { bits: <u32> } }
 *   fields.bin_manager.fields.bin_step = <number>
 *
 * Previous tests used `current_index` and top-level `bin_step` — those fields
 * do NOT exist on the real pool object.
 */
function makePoolObjectResponse(activeBinId: number, binStep: number): object {
  const bits = activeBinId < 0 ? activeBinId + 0x100000000 : activeBinId;
  return {
    data: {
      content: {
        fields: {
          active_id: {
            type: "0x...::I32",
            fields: { bits },
          },
          bin_manager: {
            type: "0x...::BinManager",
            fields: {
              bin_step: binStep,
            },
          },
        },
      },
    },
  };
}

/** Fake SuiClient for live feed (getObject). */
function makeFakePoolClient(activeBinId: number, binStep: number): object {
  return {
    getObject: async () => makePoolObjectResponse(activeBinId, binStep),
  };
}

interface FakeQueryPage {
  events: SuiEvent[];
  hasNextPage: boolean;
  nextCursor?: { txDigest: string; eventSeq: string } | null;
}

/** Build a multi-page fake queryEvents client. */
function makeQueryEventsClient(pages: FakeQueryPage[]): object {
  let pageIndex = 0;
  return {
    queryEvents: async () => {
      const page = pages[pageIndex] ?? { events: [], hasNextPage: false };
      pageIndex = Math.min(pageIndex + 1, pages.length);
      return {
        data: page.events,
        hasNextPage: page.hasNextPage,
        nextCursor: page.nextCursor ?? null,
      };
    },
  };
}

/** Build a fake client that supports both getObject and queryEvents. */
function makeDualFakeClient(
  activeBinId: number,
  binStep: number,
  pages: FakeQueryPage[],
): object {
  let pageIndex = 0;
  return {
    getObject: async () => makePoolObjectResponse(activeBinId, binStep),
    queryEvents: async () => {
      const page = pages[pageIndex] ?? { events: [], hasNextPage: false };
      pageIndex = Math.min(pageIndex + 1, pages.length);
      return {
        data: page.events,
        hasNextPage: page.hasNextPage,
        nextCursor: page.nextCursor ?? null,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Live feed tests
// ---------------------------------------------------------------------------

describe("createCetusEventsFeed", () => {
  describe("initial state", () => {
    it("latest() returns zeros before first poll", () => {
      const client = makeFakePoolClient(0, BIN_STEP);
      const feed = createCetusEventsFeed({
        poolId: POOL_ID,
        poolCoinADecimals: POOL_COIN_A_DECIMALS,
        poolCoinBDecimals: POOL_COIN_B_DECIMALS,
        clientOverride: client,
      });
      const state = feed.latest();
      expect(state.activeBin).toBe(0);
      // binStep is 0 before first poll (the pool object provides the real value).
      expect(typeof state.binStep).toBe("number");
    });

    it("lastUpdatedMs() is 0 before first poll", () => {
      const client = makeFakePoolClient(-5990, BIN_STEP);
      const feed = createCetusEventsFeed({
        poolId: POOL_ID,
        poolCoinADecimals: POOL_COIN_A_DECIMALS,
        poolCoinBDecimals: POOL_COIN_B_DECIMALS,
        clientOverride: client,
      });
      expect(feed.lastUpdatedMs()).toBe(0);
    });
  });

  describe("after polling", () => {
    it("updates activeBin and price after start()", async () => {
      // bin id -5990 with binStep=10:
      // priceFromBinIdAsQuote(-5990, 10, 6, 9) = 10^3 / (1.001^-5990) = 1000 * (1.001^5990)
      const binId = -5990;
      const client = makeFakePoolClient(binId, BIN_STEP);
      const feed = createCetusEventsFeed({
        poolId: POOL_ID,
        poolCoinADecimals: POOL_COIN_A_DECIMALS,
        poolCoinBDecimals: POOL_COIN_B_DECIMALS,
        clientOverride: client,
        pollIntervalMs: 1_000_000, // don't auto-repoll in tests
      });

      const stop = feed.start();
      await new Promise((r) => setTimeout(r, 50));
      stop();

      const state = feed.latest();
      expect(state.activeBin).toBe(binId);
      expect(state.binStep).toBe(BIN_STEP);
      expect(typeof state.price).toBe("string");
      expect(Number(state.price)).toBeGreaterThan(0);
    });

    it("handles positive bin ids", async () => {
      const binId = 1000;
      const client = makeFakePoolClient(binId, BIN_STEP);
      const feed = createCetusEventsFeed({
        poolId: POOL_ID,
        poolCoinADecimals: POOL_COIN_A_DECIMALS,
        poolCoinBDecimals: POOL_COIN_B_DECIMALS,
        clientOverride: client,
        pollIntervalMs: 1_000_000,
      });

      const stop = feed.start();
      await new Promise((r) => setTimeout(r, 50));
      stop();

      expect(feed.latest().activeBin).toBe(binId);
    });

    it("updates lastUpdatedMs() after successful poll", async () => {
      const before = Date.now();
      const client = makeFakePoolClient(-5990, BIN_STEP);
      const feed = createCetusEventsFeed({
        poolId: POOL_ID,
        poolCoinADecimals: POOL_COIN_A_DECIMALS,
        poolCoinBDecimals: POOL_COIN_B_DECIMALS,
        clientOverride: client,
        pollIntervalMs: 1_000_000,
      });

      const stop = feed.start();
      await new Promise((r) => setTimeout(r, 50));
      stop();

      expect(feed.lastUpdatedMs()).toBeGreaterThanOrEqual(before);
    });

    it("latest() returns a copy (mutations don't affect internal state)", async () => {
      const client = makeFakePoolClient(-5990, BIN_STEP);
      const feed = createCetusEventsFeed({
        poolId: POOL_ID,
        poolCoinADecimals: POOL_COIN_A_DECIMALS,
        poolCoinBDecimals: POOL_COIN_B_DECIMALS,
        clientOverride: client,
        pollIntervalMs: 1_000_000,
      });

      const stop = feed.start();
      await new Promise((r) => setTimeout(r, 50));
      stop();

      const s1 = feed.latest();
      (s1 as { activeBin: number }).activeBin = 99999;

      const s2 = feed.latest();
      expect(s2.activeBin).not.toBe(99999);
    });
  });

  describe("stop function", () => {
    it("stop() can be called multiple times without throwing", () => {
      const client = makeFakePoolClient(-5990, BIN_STEP);
      const feed = createCetusEventsFeed({
        poolId: POOL_ID,
        poolCoinADecimals: POOL_COIN_A_DECIMALS,
        poolCoinBDecimals: POOL_COIN_B_DECIMALS,
        clientOverride: client,
      });
      const stop = feed.start();
      expect(() => { stop(); stop(); }).not.toThrow();
    });
  });

  describe("pool object field shape regression", () => {
    it("throws with an explicit error when active_id is missing (not silent defaults)", async () => {
      // Pool object with the OLD (wrong) field layout: current_index at top-level.
      // This should throw — not silently default to activeBin=0.
      const badClient = {
        getObject: async () => ({
          data: {
            content: {
              fields: {
                current_index: { bits: 1442 }, // wrong path — should be active_id.fields.bits
                bin_step: 50,                   // wrong path — should be bin_manager.fields.bin_step
              },
            },
          },
        }),
      };

      const feed = createCetusEventsFeed({
        poolId: POOL_ID,
        poolCoinADecimals: POOL_COIN_A_DECIMALS,
        poolCoinBDecimals: POOL_COIN_B_DECIMALS,
        clientOverride: badClient,
        pollIntervalMs: 1_000_000,
      });

      // start() fires the first poll; the error is caught and logged at 'error' level.
      // We verify the underlying queryPoolState throws by calling the feed and
      // checking the feed was NOT updated (lastUpdatedMs remains 0).
      const stop = feed.start();
      await new Promise((r) => setTimeout(r, 50));
      stop();

      // lastUpdatedMs should still be 0 because the poll errored.
      expect(feed.lastUpdatedMs()).toBe(0);
    });

    it("throws when pool object has no content fields at all", async () => {
      const emptyClient = {
        getObject: async () => ({ data: {} }),
      };

      const feed = createCetusEventsFeed({
        poolId: POOL_ID,
        poolCoinADecimals: POOL_COIN_A_DECIMALS,
        poolCoinBDecimals: POOL_COIN_B_DECIMALS,
        clientOverride: emptyClient,
        pollIntervalMs: 1_000_000,
      });

      const stop = feed.start();
      await new Promise((r) => setTimeout(r, 50));
      stop();

      expect(feed.lastUpdatedMs()).toBe(0);
    });

    it("reads binStep from bin_manager.fields.bin_step (not top-level)", async () => {
      // Real layout: binStep lives at fields.bin_manager.fields.bin_step = 50.
      const client = makeFakePoolClient(1442, 50);
      const feed = createCetusEventsFeed({
        poolId: POOL_ID,
        poolCoinADecimals: POOL_COIN_A_DECIMALS,
        poolCoinBDecimals: POOL_COIN_B_DECIMALS,
        clientOverride: client,
        pollIntervalMs: 1_000_000,
      });

      const stop = feed.start();
      await new Promise((r) => setTimeout(r, 50));
      stop();

      expect(feed.latest().binStep).toBe(50);
    });
  });

  describe("price normalization", () => {
    it("produces human USDC-per-SUI price close to Binance for the live mainnet numbers", async () => {
      // Ground truth (verified 2026-06 against mainnet):
      //   active_id.bits = 1442, binStep = 50, pool = Pool<USDC=6, SUI=9>
      //   Binance SUIUSDC ≈ 0.7486; expected feed price ≈ 0.7526 (within 1%)
      //
      // Formula: priceFromBinIdAsQuote(1442, 50, 6, 9)
      //   = 10^(9-6) / (1.005^1442)
      //   = 1000 / 1328.8
      //   ≈ 0.7526
      const client = makeFakePoolClient(1442, 50);
      const feed = createCetusEventsFeed({
        poolId: POOL_ID,
        poolCoinADecimals: 6,
        poolCoinBDecimals: 9,
        clientOverride: client,
        pollIntervalMs: 1_000_000,
      });

      const stop = feed.start();
      await new Promise((r) => setTimeout(r, 50));
      stop();

      const state = feed.latest();
      expect(state.activeBin).toBe(1442);
      expect(state.binStep).toBe(50);

      const price = Number(state.price);
      // Expected: ~0.7526. Allow ±5% for rounding in toPrecision.
      expect(price).toBeGreaterThan(0.70);
      expect(price).toBeLessThan(0.80);
      // Tighter check: within 1% of 0.7526.
      expect(Math.abs(price - 0.7526) / 0.7526).toBeLessThan(0.01);
    });

    it("price is NOT in lamport units (must be < 100 for a sub-dollar token)", async () => {
      // The old broken formula returned ~1328.8 (lamport-B-per-A).
      // After the fix, price must be a human value < 100.
      const client = makeFakePoolClient(1442, 50);
      const feed = createCetusEventsFeed({
        poolId: POOL_ID,
        poolCoinADecimals: 6,
        poolCoinBDecimals: 9,
        clientOverride: client,
        pollIntervalMs: 1_000_000,
      });

      const stop = feed.start();
      await new Promise((r) => setTimeout(r, 50));
      stop();

      const price = Number(feed.latest().price);
      expect(price).toBeLessThan(100);
      expect(price).toBeGreaterThan(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Backfill tests
// ---------------------------------------------------------------------------

describe("backfillSwapEvents", () => {
  describe("single page backfill", () => {
    it("invokes onBatch with parsed swap records", async () => {
      const baseTs = 1_700_000_000_000;
      const events = [
        makeSwapEvent(-5990, baseTs + 2_000, "tx1", "0"),
        makeSwapEvent(-5991, baseTs + 1_000, "tx2", "0"),
        makeSwapEvent(-5992, baseTs, "tx3", "0"),
      ];

      const client = makeQueryEventsClient([
        { events, hasNextPage: false, nextCursor: null },
      ]);

      const batches: SwapEventRecord[][] = [];
      await backfillSwapEvents({
        poolId: POOL_ID,
        binStep: BIN_STEP,
        poolCoinADecimals: POOL_COIN_A_DECIMALS,
        poolCoinBDecimals: POOL_COIN_B_DECIMALS,
        fromMs: baseTs - 1,
        clientOverride: client,
        onBatch: (b) => { batches.push(b); },
      });

      expect(batches.length).toBeGreaterThan(0);
      const allRecords = batches.flat();
      expect(allRecords.length).toBe(3);
      // All records belong to the correct pool.
      expect(allRecords.every((r) => r.poolId === POOL_ID)).toBe(true);
    });

    it("sets price and binId on each record", async () => {
      const baseTs = 1_700_000_000_000;
      const events = [makeSwapEvent(-5990, baseTs, "tx1", "0")];
      const client = makeQueryEventsClient([
        { events, hasNextPage: false, nextCursor: null },
      ]);

      const records: SwapEventRecord[] = [];
      await backfillSwapEvents({
        poolId: POOL_ID,
        binStep: BIN_STEP,
        poolCoinADecimals: POOL_COIN_A_DECIMALS,
        poolCoinBDecimals: POOL_COIN_B_DECIMALS,
        clientOverride: client,
        onBatch: (b) => b.forEach((r) => records.push(r)),
      });

      expect(records.length).toBe(1);
      const first = records[0];
      if (!first) throw new Error("expected records[0]");
      expect(first.binId).toBe(-5990);
      expect(typeof first.price).toBe("string");
      expect(Number(first.price)).toBeGreaterThan(0);
    });

    it("stores human prices (not lamport-level raw ratios) in price records", async () => {
      // binId=1442, binStep=50, poolCoinADecimals=6, poolCoinBDecimals=9
      // Expected price ≈ 0.7526 (USDC/SUI), not 1328.8 (lamport-B/A raw ratio).
      const baseTs = 1_700_000_000_000;
      const events = [makeSwapEvent(1442, baseTs, "tx1", "0")];
      const client = makeQueryEventsClient([
        { events, hasNextPage: false, nextCursor: null },
      ]);

      const records: SwapEventRecord[] = [];
      await backfillSwapEvents({
        poolId: POOL_ID,
        binStep: 50,
        poolCoinADecimals: 6,
        poolCoinBDecimals: 9,
        clientOverride: client,
        onBatch: (b) => b.forEach((r) => records.push(r)),
      });

      expect(records.length).toBe(1);
      const r = records[0]!;
      expect(r.binId).toBe(1442);
      const price = Number(r.price);
      expect(price).toBeGreaterThan(0.70);
      expect(price).toBeLessThan(0.80);
      // Must NOT be lamport-level (which would be ~1328.8).
      expect(price).toBeLessThan(100);
    });
  });

  describe("multi-page backfill pagination", () => {
    it("follows hasNextPage and collects all pages", async () => {
      const baseTs = 1_700_000_000_000;

      const page1Events = [
        makeSwapEvent(-5990, baseTs + 3_000, "tx1", "0"),
        makeSwapEvent(-5991, baseTs + 2_000, "tx2", "0"),
      ];
      const page2Events = [
        makeSwapEvent(-5992, baseTs + 1_000, "tx3", "0"),
        makeSwapEvent(-5993, baseTs, "tx4", "0"),
      ];

      const client = makeQueryEventsClient([
        {
          events: page1Events,
          hasNextPage: true,
          nextCursor: { txDigest: "tx2", eventSeq: "0" },
        },
        {
          events: page2Events,
          hasNextPage: false,
          nextCursor: null,
        },
      ]);

      const allRecords: SwapEventRecord[] = [];
      await backfillSwapEvents({
        poolId: POOL_ID,
        binStep: BIN_STEP,
        poolCoinADecimals: POOL_COIN_A_DECIMALS,
        poolCoinBDecimals: POOL_COIN_B_DECIMALS,
        fromMs: baseTs - 1,
        clientOverride: client,
        onBatch: (b) => b.forEach((r) => allRecords.push(r)),
      });

      expect(allRecords.length).toBe(4);
    });

    it("stops when event timestamp falls below fromMs", async () => {
      const baseTs = 1_700_000_000_000;
      const cutoff = baseTs + 500;

      // Page has events both above and below the cutoff.
      const events = [
        makeSwapEvent(-5990, baseTs + 1_000, "tx1", "0"), // above cutoff
        makeSwapEvent(-5991, baseTs + 100, "tx2", "0"),  // below cutoff
      ];

      const client = makeQueryEventsClient([
        { events, hasNextPage: true, nextCursor: { txDigest: "tx2", eventSeq: "0" } },
      ]);

      const allRecords: SwapEventRecord[] = [];
      await backfillSwapEvents({
        poolId: POOL_ID,
        binStep: BIN_STEP,
        poolCoinADecimals: POOL_COIN_A_DECIMALS,
        poolCoinBDecimals: POOL_COIN_B_DECIMALS,
        fromMs: cutoff,
        clientOverride: client,
        onBatch: (b) => b.forEach((r) => allRecords.push(r)),
      });

      // Only the event above cutoff should be collected.
      expect(allRecords.length).toBe(1);
      const aboveCutoff = allRecords[0];
      if (!aboveCutoff) throw new Error("expected allRecords[0]");
      expect(aboveCutoff.timestampMs).toBe(baseTs + 1_000);
    });

    it("skips events for other pools", async () => {
      const baseTs = 1_700_000_000_000;
      const events = [
        makeSwapEvent(-5990, baseTs, "tx1", "0", POOL_ID),
        makeSwapEvent(-5991, baseTs - 100, "tx2", "0", "0xother_pool"),
      ];

      const client = makeQueryEventsClient([
        { events, hasNextPage: false, nextCursor: null },
      ]);

      const allRecords: SwapEventRecord[] = [];
      await backfillSwapEvents({
        poolId: POOL_ID,
        binStep: BIN_STEP,
        poolCoinADecimals: POOL_COIN_A_DECIMALS,
        poolCoinBDecimals: POOL_COIN_B_DECIMALS,
        fromMs: baseTs - 200,
        clientOverride: client,
        onBatch: (b) => b.forEach((r) => allRecords.push(r)),
      });

      expect(allRecords.every((r) => r.poolId === POOL_ID)).toBe(true);
      expect(allRecords.length).toBe(1);
    });
  });

  describe("cursor resume", () => {
    it("calls onBatch correctly when no DB is initialized (no cursor saved)", async () => {
      // Without a DB, loadCursor returns null and we start from the beginning.
      const baseTs = 1_700_000_000_000;
      const events = [makeSwapEvent(-5990, baseTs, "tx1", "0")];
      const client = makeQueryEventsClient([
        { events, hasNextPage: false, nextCursor: null },
      ]);

      const records: SwapEventRecord[] = [];
      // Should not throw even without a DB (saveCursor gracefully handles no-DB).
      await expect(
        backfillSwapEvents({
          poolId: POOL_ID,
          binStep: BIN_STEP,
          poolCoinADecimals: POOL_COIN_A_DECIMALS,
          poolCoinBDecimals: POOL_COIN_B_DECIMALS,
          fromMs: 0,
          clientOverride: client,
          onBatch: (b) => b.forEach((r) => records.push(r)),
        }),
      ).resolves.toBeUndefined();

      expect(records.length).toBe(1);
    });

    it("processes all events when starting fresh (no saved cursor)", async () => {
      const baseTs = 1_700_000_000_000;
      const page1 = [makeSwapEvent(-5990, baseTs + 2_000, "tx1", "2")];
      const page2 = [makeSwapEvent(-5991, baseTs + 1_000, "tx2", "1")];

      // Simulate two pages, no saved cursor.
      const pages: FakeQueryPage[] = [
        { events: page1, hasNextPage: true, nextCursor: { txDigest: "tx2", eventSeq: "1" } },
        { events: page2, hasNextPage: false },
      ];
      const client = makeQueryEventsClient(pages);

      const allRecords: SwapEventRecord[] = [];
      await backfillSwapEvents({
        poolId: POOL_ID,
        binStep: BIN_STEP,
        poolCoinADecimals: POOL_COIN_A_DECIMALS,
        poolCoinBDecimals: POOL_COIN_B_DECIMALS,
        fromMs: baseTs,
        clientOverride: client,
        onBatch: (b) => b.forEach((r) => allRecords.push(r)),
      });

      expect(allRecords.length).toBe(2);
    });
  });

  describe("empty pages", () => {
    it("handles empty event pages gracefully", async () => {
      const client = makeQueryEventsClient([
        { events: [], hasNextPage: false, nextCursor: null },
      ]);

      const records: SwapEventRecord[] = [];
      await expect(
        backfillSwapEvents({
          poolId: POOL_ID,
          binStep: BIN_STEP,
          poolCoinADecimals: POOL_COIN_A_DECIMALS,
          poolCoinBDecimals: POOL_COIN_B_DECIMALS,
          clientOverride: client,
          onBatch: (b) => b.forEach((r) => records.push(r)),
        }),
      ).resolves.toBeUndefined();

      expect(records.length).toBe(0);
    });
  });

  describe("toMs filtering", () => {
    it("skips events newer than toMs", async () => {
      const baseTs = 1_700_000_000_000;
      const toMs = baseTs + 500;

      const events = [
        makeSwapEvent(-5990, baseTs + 1_000, "tx1", "0"), // above toMs → skip
        makeSwapEvent(-5991, baseTs + 300, "tx2", "0"),   // below toMs → include
      ];

      const client = makeQueryEventsClient([
        { events, hasNextPage: false, nextCursor: null },
      ]);

      const records: SwapEventRecord[] = [];
      await backfillSwapEvents({
        poolId: POOL_ID,
        binStep: BIN_STEP,
        poolCoinADecimals: POOL_COIN_A_DECIMALS,
        poolCoinBDecimals: POOL_COIN_B_DECIMALS,
        fromMs: 0,
        toMs,
        clientOverride: client,
        onBatch: (b) => b.forEach((r) => records.push(r)),
      });

      expect(records.length).toBe(1);
      const r0 = records[0];
      if (!r0) throw new Error("expected records[0]");
      expect(r0.timestampMs).toBe(baseTs + 300);
    });
  });
});
