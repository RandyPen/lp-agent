/**
 * ShadowFleet — runs N RULE strategies side-by-side on HYPOTHETICAL books,
 * judged by real on-chain SwapEvents (see shadowBook.ts for the fill rule).
 *
 * Per strategy, each tick:
 *   1. Synthetic PMState from its ShadowBook (v0-read fidelity).
 *   2. Real pool state + price history from the live feeds.
 *   3. strategy.plan() — the REAL strategy code, including presenceSweep's
 *      fillBoundary persistence (synthetic pmId "shadow:<name>" rides the
 *      real position_state channel; this module mimics the rebalancer's
 *      save-on-plan behaviour).
 *   4. Plan applied hypothetically to the book; NAV vs HODL sampled into
 *      `shadow_nav`; the book serialized into `shadow_books` (restart-safe).
 *
 * A cursor-based poller (event_cursor stream 'shadow_fleet_swaps') pulls new
 * SwapEvents with the full per-bin breakdown and feeds every book. NOTHING
 * here submits transactions — observability only, same guarantee as
 * shadowRunner (not wired into tickOne; no executor dependency at all).
 */

import type { Database } from "bun:sqlite";
import type { PoolProfile } from "../pools/types.ts";
import type { PriceFeed } from "../data/priceFeed.ts";
import type { Strategy, StrategyInput } from "../strategies/types.ts";
import { buildStrategy, isStrategyName, type StrategyName } from "../strategies/registry.ts";
import { saveFillBoundary } from "../strategies/positionState.ts";
import { getSuiClient } from "../sui/client.ts";
import {
  ShadowBook,
  parseSwapEvent,
  type RawDlmmSwapEvent,
} from "./shadowBook.ts";
import { binIdForHumanPrice, orientationOf } from "../domain/binMath.ts";
import { log } from "../lib/logger.ts";

const DLMM_PACKAGE_MAINNET =
  "0x5664f9d3fd82c84023870cfbda8ea84e14c8dd56ce557ad2116e0668581a682b";
const CURSOR_STREAM = "shadow_fleet_swaps";
const SWAP_POLL_MS = 30_000;
const SWAP_PAGE_LIMIT = 50;
/** Pages per poll before declaring a gap (≈500 swaps; the pool does ~260/day). */
const SWAP_MAX_PAGES = 10;

export interface ShadowFleetOptions {
  db: Database;
  profile: PoolProfile;
  priceFeed: PriceFeed;
  /** Rule strategies to shadow (mlAgent is not supported here). */
  strategies: StrategyName[];
  /** Initial hypothetical inventory (raw physical units). */
  initialA: bigint;
  initialB: bigint;
  /**
   * Live pool state source (e.g. the cetus feed). Optional: when absent the
   * active bin is derived from the spot price via bin math — accurate to ±1
   * bin, adequate for shadow placement.
   */
  getPoolState?: () => { activeBin: number; binStep: number } | null;
  tickIntervalMs?: number;
  feeRateBps?: number;
  now?: () => number;
  /** Injectable SuiClient-like (queryEvents) — tests / standalone probes. */
  clientOverride?: unknown;
}

export interface ShadowFleet {
  start(): () => void;
  /** One evaluation pass over all strategies (exposed for tests). */
  tickOnce(): Promise<void>;
  /** One swap-poll pass (exposed for tests). */
  pollSwapsOnce(): Promise<void>;
}

interface Slot {
  name: StrategyName;
  strategy: Strategy;
  book: ShadowBook;
  pmId: string;
}

export function createShadowFleet(opts: ShadowFleetOptions): ShadowFleet {
  const { db, profile, priceFeed } = opts;
  const now = opts.now ?? (() => Date.now());
  const tickIntervalMs = opts.tickIntervalMs ?? 60_000;
  const feeRateBps = opts.feeRateBps ?? profile.defaultStrategyParams.expectedFeeBps;

  // Physical coin types: physical A is the QUOTE asset when poolCoinAIsQuote
  // (for sui-usdc: A=USDC=logical coinTypeB, B=SUI=logical coinTypeA).
  const physicalTypeA = profile.poolCoinAIsQuote ? profile.coinTypeB : profile.coinTypeA;
  const physicalTypeB = profile.poolCoinAIsQuote ? profile.coinTypeA : profile.coinTypeB;

  // ---- slots: strategy + restored-or-fresh book ---------------------------
  const slots: Slot[] = opts.strategies.map((name) => {
    if (!isStrategyName(name) || name === "mlAgent") {
      throw new Error(`shadowFleet: unsupported shadow strategy '${name}'`);
    }
    const row = db
      .query<{ book_json: string }, [string]>(
        `SELECT book_json FROM shadow_books WHERE strategy = ?`,
      )
      .get(name);
    const book = row
      ? ShadowBook.restore(profile, JSON.parse(row.book_json))
      : new ShadowBook(profile, opts.initialA, opts.initialB);
    if (row) {
      log.info("shadowFleet: restored book", { strategy: name });
    }
    return { name, strategy: buildStrategy(name), book, pmId: `shadow:${name}` };
  });

  const persistBook = (slot: Slot): void => {
    db.prepare(
      `INSERT INTO shadow_books (strategy, book_json, updated_at_ms)
       VALUES (?, ?, ?)
       ON CONFLICT(strategy) DO UPDATE SET
         book_json = excluded.book_json, updated_at_ms = excluded.updated_at_ms`,
    ).run(slot.name, JSON.stringify(slot.book.serialize()), now());
  };

  // ---- swap poller ---------------------------------------------------------

  function loadCursor(): { txDigest: string; eventSeq: string } | null {
    const row = db
      .query<{ tx_digest: string | null; event_seq: string | null }, [string]>(
        `SELECT tx_digest, event_seq FROM event_cursor WHERE stream = ?`,
      )
      .get(CURSOR_STREAM);
    return row?.tx_digest && row.event_seq
      ? { txDigest: row.tx_digest, eventSeq: row.event_seq }
      : null;
  }

  function saveCursor(c: { txDigest: string; eventSeq: string }): void {
    db.prepare(
      `INSERT INTO event_cursor (stream, tx_digest, event_seq, updated_ms)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(stream) DO UPDATE SET
         tx_digest = excluded.tx_digest, event_seq = excluded.event_seq,
         updated_ms = excluded.updated_ms`,
    ).run(CURSOR_STREAM, c.txDigest, c.eventSeq, now());
  }

  async function pollSwapsOnce(): Promise<void> {
    const client = (opts.clientOverride ?? getSuiClient()) as unknown as {
      queryEvents(a: object): Promise<{
        data: {
          id: { txDigest: string; eventSeq: string };
          timestampMs?: string;
          parsedJson?: unknown;
        }[];
        hasNextPage: boolean;
        nextCursor: { txDigest: string; eventSeq: string } | null;
      }>;
    };
    const lastSeen = loadCursor();
    const collected: { raw: RawDlmmSwapEvent; ts: number; id: { txDigest: string; eventSeq: string } }[] = [];
    let cursor: { txDigest: string; eventSeq: string } | null = null;
    let reachedKnown = lastSeen === null; // first run: process only page 1
    let pages = 0;

    while (pages < SWAP_MAX_PAGES) {
      const res = await client.queryEvents({
        query: { MoveEventType: `${DLMM_PACKAGE_MAINNET}::pool::SwapEvent` },
        cursor,
        limit: SWAP_PAGE_LIMIT,
        order: "descending",
      });
      pages++;
      let stop = false;
      for (const ev of res.data) {
        if (lastSeen && ev.id.txDigest === lastSeen.txDigest && ev.id.eventSeq === lastSeen.eventSeq) {
          reachedKnown = true;
          stop = true;
          break;
        }
        const raw = ev.parsedJson as RawDlmmSwapEvent | undefined;
        if (raw && raw.pool === profile.poolId && Array.isArray(raw.bin_swaps)) {
          collected.push({ raw, ts: Number(ev.timestampMs ?? now()), id: ev.id });
        }
      }
      if (stop || !res.hasNextPage || !res.nextCursor) break;
      cursor = res.nextCursor;
      if (lastSeen === null) break; // cold start: one page seeds the cursor
    }
    if (lastSeen && !reachedKnown && pages >= SWAP_MAX_PAGES) {
      log.warn("shadowFleet: swap poll hit page cap before reaching cursor — possible gap", {
        pages, collected: collected.length,
      });
    }
    if (collected.length === 0) return;

    // Newest-first from RPC → apply oldest-first.
    collected.reverse();
    for (const item of collected) {
      let parsed;
      try {
        parsed = parseSwapEvent(item.raw, physicalTypeA, physicalTypeB, item.ts);
      } catch (err) {
        log.warn("shadowFleet: unparseable swap event skipped", { err: String(err) });
        continue;
      }
      for (const slot of slots) slot.book.applySwap(parsed);
    }
    const newest = collected[collected.length - 1]!;
    saveCursor(newest.id);
    for (const slot of slots) persistBook(slot);
    log.debug("shadowFleet: applied swaps", { count: collected.length });
  }

  // ---- strategy tick -------------------------------------------------------

  async function tickOnce(): Promise<void> {
    const spot = await priceFeed.getSpot();
    const priceNum = Number(spot.price);
    if (!Number.isFinite(priceNum) || priceNum <= 0) return;
    const external = opts.getPoolState?.();
    const pool =
      external && external.binStep > 0
        ? external
        : {
            activeBin: binIdForHumanPrice(orientationOf(profile), priceNum),
            binStep: profile.binStep,
          };

    for (const slot of slots) {
      try {
        const history = await priceFeed.getHistory(
          slot.strategy.historyWindowMs ?? 5 * 60 * 1000,
        );
        const input: StrategyInput = {
          pm: slot.book.toPmState(slot.pmId, profile.poolId, physicalTypeA, physicalTypeB),
          pool: {
            poolId: profile.poolId,
            activeBinId: pool.activeBin,
            binStep: pool.binStep,
            feeRateBps,
          },
          spot,
          history,
          profile,
        };
        const output = await slot.strategy.plan(input);

        let regime: string | null = null;
        let note: string = output.kind;
        if (output.kind === "plan_and_reconcile" || output.kind === "plan_only") {
          slot.book.applyPlan(output.plan);
          note = output.plan.reason.slice(0, 180);
          regime = output.stateCtx?.state ?? null;
          if (output.fillBoundary !== undefined) {
            // Mimic the rebalancer's persistence for the shadow pmId.
            saveFillBoundary(slot.pmId, output.fillBoundary, slot.strategy.name);
          }
        } else {
          regime = "stateCtx" in output ? output.stateCtx?.state ?? null : null;
          note = `${output.kind}: ${"reason" in output ? output.reason.slice(0, 160) : ""}`;
        }

        db.prepare(
          `INSERT INTO shadow_nav
             (strategy, ts_ms, nav_quote, hodl_quote, price, fee_income_quote,
              fills, skipped_terminal_fills, regime, note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          slot.name,
          now(),
          slot.book.navQuote(priceNum),
          slot.book.hodlQuote(priceNum),
          priceNum,
          slot.book.feeIncomeQuote(priceNum),
          slot.book.fills,
          slot.book.skippedTerminalFills,
          regime,
          note,
        );
        persistBook(slot);
      } catch (err) {
        // A shadow failure must never affect anything else — log and move on.
        log.warn("shadowFleet: tick failed for strategy", {
          strategy: slot.name,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return {
    tickOnce,
    pollSwapsOnce,
    start(): () => void {
      log.info("shadowFleet: starting", {
        strategies: slots.map((s) => s.name),
        tickIntervalMs,
      });
      const tickTimer = setInterval(() => {
        tickOnce().catch((err) =>
          log.warn("shadowFleet: tick loop error", { err: String(err) }),
        );
      }, tickIntervalMs);
      const swapTimer = setInterval(() => {
        pollSwapsOnce().catch((err) =>
          log.warn("shadowFleet: swap poll error", { err: String(err) }),
        );
      }, SWAP_POLL_MS);
      return () => {
        clearInterval(tickTimer);
        clearInterval(swapTimer);
      };
    },
  };
}
