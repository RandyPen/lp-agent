/**
 * PnL accounting service (D1/D2) — the persistence + NAV wrapper around the
 * pure in-memory `createPnlAttributor`.
 *
 * Responsibilities:
 *   - `computeNavUsd`: honest portfolio NAV = idle balances + fee bag +
 *     lending principal + the OPEN POSITION MARK. Per-bin position amounts
 *     are 0n in v0 chain reads, so the position is marked from the
 *     `position_entry_snapshots` row (what was deployed at the last add,
 *     valued at the current spot — a hold-value approximation; the in-range
 *     IL drift is measured separately at remove time).
 *   - `recordTick`: persists one `pnl_ticks` row per evaluated rebalancer
 *     tick (including quiet ticks — NAV must be sampled continuously for the
 *     24h window) and feeds the in-memory attributor for `summarize()`.
 *   - `get24hPnlPct`: NAV mark-to-market over the last 24h — THE seam the
 *     risk monitor's daily-loss circuits consume. Honesty rules: null when
 *     coverage is insufficient (< 20h) or the baseline NAV is unusable;
 *     never fabricate 0 from an empty window.
 *   - `snapshotEntry` / `computeIlUsd`: entry bookkeeping + impermanent-loss
 *     measurement (hold-value of the entry amounts at the current spot vs
 *     the realized remove proceeds).
 *
 * Units: all `*_usd` values are human quote units (USDC for SUI/USDC).
 * Treasury costs stay in CREDITS (`cost_credits`) — converting to USD would
 * fabricate an exchange rate the system doesn't own; the attributor's
 * `rebalanceCost` component is therefore fed 0 and reporting reads credits
 * from the tick rows directly.
 */

import type { Database } from "bun:sqlite";
import type { PMState, RebalancePlan } from "../domain/types.ts";
import type { PoolProfile } from "../pools/types.ts";
import {
  createPnlAttributor,
  type Get24hPnlPct,
  type PnlAttributor,
} from "../risk/pnlAttribution.ts";
import { log } from "../lib/logger.ts";

export interface PnlService {
  /** Honest NAV in quote units; see module doc for the composition. */
  computeNavUsd(pm: PMState, spotHumanPrice: number): number;
  /** Value a PHYSICAL (a, b) raw amount pair in quote units at the spot. */
  valuePhysicalUsd(a: bigint, b: bigint, spotHumanPrice: number): number;
  /** Record one evaluated tick (quiet ticks too — NAV sampling). */
  recordTick(tick: {
    poolId: string;
    pmId: string;
    tsMs: number;
    feeIncomeUsd: number;
    costCredits: number;
    navUsd: number;
    ilUsd: number | null;
    marketState: "NORMAL" | "TREND" | "EXTREME" | null;
    rebalanceId: number | null;
  }): void;
  /** 24h NAV mark-to-market fraction, or null when not honestly computable. */
  get24hPnlPct: Get24hPnlPct;
  /**
   * Upsert the entry snapshot after a SUCCEEDED add (what was deployed).
   * A plan that adds nothing clears the snapshot (position closed).
   */
  snapshotEntry(pmId: string, plan: RebalancePlan, spotHumanPrice: number, nowMs: number): void;
  /**
   * Impermanent loss realized by a remove: (realized proceeds value) −
   * (hold-value of the entry amounts at the current spot). Negative = the
   * LP position underperformed simply holding. Null when no entry snapshot.
   */
  computeIlUsd(
    pmId: string,
    proceeds: { a: bigint; b: bigint },
    spotHumanPrice: number,
  ): number | null;
  /** The in-memory attributor (for summarize() reporting). */
  readonly attributor: PnlAttributor;
}

export interface PnlServiceDeps {
  db: Database;
  profile: PoolProfile;
  nowMs?: () => number;
}

interface EntryRow {
  ts_ms: number;
  amount_a: string;
  amount_b: string;
  spot_price: number;
  entry_value_usd: number;
}

export function createPnlService(deps: PnlServiceDeps): PnlService {
  const { db, profile } = deps;
  const nowMs = deps.nowMs ?? (() => Date.now());
  const attributor = createPnlAttributor({ nowMs });

  // Physical decimal + orientation facts for valuing raw amounts.
  const physADec = profile.poolCoinADecimals ?? profile.decimalsA;
  const physBDec = profile.poolCoinBDecimals ?? profile.decimalsB;
  const aIsQuote = profile.poolCoinAIsQuote ?? false;

  /** Value a PHYSICAL (a, b) raw pair in quote units at the given spot. */
  function valueUsd(a: bigint, b: bigint, spot: number): number {
    const aHuman = Number(a) / Math.pow(10, physADec);
    const bHuman = Number(b) / Math.pow(10, physBDec);
    // The quote-side coin is worth 1 per unit; the base side is worth `spot`.
    return aIsQuote ? aHuman + bHuman * spot : aHuman * spot + bHuman;
  }

  /** Value a lending principal (keyed by coin type) in quote units. */
  function lendingValueUsd(pm: PMState, spot: number): number {
    // profile.coinTypeA is the LOGICAL base coin; coinTypeB the quote.
    const baseType = profile.coinTypeA;
    const quoteType = profile.coinTypeB;
    const baseDec = profile.decimalsA;
    const quoteDec = profile.decimalsB;
    let total = 0;
    for (const protocol of ["scallop", "kai"] as const) {
      for (const pos of Object.values(pm.lending[protocol])) {
        if (!pos) continue;
        const human =
          pos.coinType === baseType
            ? (Number(pos.underlyingPrincipal) / Math.pow(10, baseDec)) * spot
            : pos.coinType === quoteType
              ? Number(pos.underlyingPrincipal) / Math.pow(10, quoteDec)
              : 0;
        if (human === 0 && pos.underlyingPrincipal > 0n) {
          log.warn("pnlService: lending position in unknown coin type ignored in NAV", {
            coinType: pos.coinType,
          });
        }
        total += human;
      }
    }
    return total;
  }

  function getEntry(pmId: string): EntryRow | null {
    return (
      db
        .prepare<EntryRow, [string]>(
          `SELECT ts_ms, amount_a, amount_b, spot_price, entry_value_usd
           FROM position_entry_snapshots WHERE pm_id = ?`,
        )
        .get(pmId) ?? null
    );
  }

  function computeNavUsd(pm: PMState, spot: number): number {
    if (!Number.isFinite(spot) || spot <= 0) {
      throw new RangeError(`pnlService.computeNavUsd: invalid spot ${spot}`);
    }
    const idle = valueUsd(pm.balance.a + pm.feeBag.a, pm.balance.b + pm.feeBag.b, spot);
    const lending = lendingValueUsd(pm, spot);
    // Position mark: hold-value of the entry amounts at the CURRENT spot.
    // Only counted while a position is actually open.
    let position = 0;
    if (pm.positionBins.length > 0) {
      const entry = getEntry(pm.pmId);
      if (entry) {
        position = valueUsd(BigInt(entry.amount_a), BigInt(entry.amount_b), spot);
      } else {
        log.warn("pnlService: open position without entry snapshot — NAV underestimates", {
          pmId: pm.pmId,
        });
      }
    }
    return idle + lending + position;
  }

  function recordTick(tick: Parameters<PnlService["recordTick"]>[0]): void {
    db.prepare(
      `INSERT INTO pnl_ticks
         (pool_id, pm_id, ts_ms, fee_income_usd, cost_credits, inventory_delta_usd,
          il_usd, nav_usd, market_state, rebalance_id)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    ).run(
      tick.poolId,
      tick.pmId,
      tick.tsMs,
      tick.feeIncomeUsd,
      tick.costCredits,
      tick.ilUsd,
      tick.navUsd,
      tick.marketState,
      tick.rebalanceId,
    );
    attributor.record({
      poolId: tick.poolId,
      ts: tick.tsMs,
      feeIncome: tick.feeIncomeUsd,
      rebalanceCost: 0, // credits deliberately NOT converted to USD
      inventoryDelta: tick.ilUsd ?? 0,
      marketState: tick.marketState,
    });
  }

  function snapshotEntry(
    pmId: string,
    plan: RebalancePlan,
    spot: number,
    ts: number,
  ): void {
    if (plan.addBins.length === 0 || (plan.addAmountA === 0n && plan.addAmountB === 0n)) {
      // Position closed (e.g. EXTREME withdrawal) — clear the snapshot.
      db.prepare(`DELETE FROM position_entry_snapshots WHERE pm_id = ?`).run(pmId);
      return;
    }
    db.prepare(
      `INSERT INTO position_entry_snapshots (pm_id, ts_ms, amount_a, amount_b, spot_price, entry_value_usd)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(pm_id) DO UPDATE SET
         ts_ms = excluded.ts_ms,
         amount_a = excluded.amount_a,
         amount_b = excluded.amount_b,
         spot_price = excluded.spot_price,
         entry_value_usd = excluded.entry_value_usd`,
    ).run(
      pmId,
      ts,
      plan.addAmountA.toString(),
      plan.addAmountB.toString(),
      spot,
      valueUsd(plan.addAmountA, plan.addAmountB, spot),
    );
  }

  function computeIlUsd(
    pmId: string,
    proceeds: { a: bigint; b: bigint },
    spot: number,
  ): number | null {
    const entry = getEntry(pmId);
    if (!entry) return null;
    const holdValue = valueUsd(BigInt(entry.amount_a), BigInt(entry.amount_b), spot);
    const realizedValue = valueUsd(proceeds.a, proceeds.b, spot);
    return realizedValue - holdValue;
  }

  // 24h pct source: NAV baseline = the earliest pnl_ticks row inside the 24h
  // window, required to be at least 20h old (coverage guard) with a usable NAV.
  const DAY_MS = 24 * 60 * 60 * 1000;
  const MIN_COVERAGE_MS = 20 * 60 * 60 * 1000;

  const get24hPnlPct: Get24hPnlPct = (poolId: string): number | null => {
    const now = nowMs();
    // Per-PM earliest row inside the 24h window (SQLite's bare-column-with-
    // MIN semantics pick the nav from the min-ts row) …
    const bases = db
      .prepare<{ pm_id: string; ts: number; nav_usd: number }, [string, number]>(
        `SELECT pm_id, MIN(ts_ms) AS ts, nav_usd FROM pnl_ticks
         WHERE pool_id = ? AND ts_ms >= ?
         GROUP BY pm_id`,
      )
      .all(poolId, now - DAY_MS);
    if (bases.length === 0) return null;

    // … and the per-PM latest row overall.
    const latests = db
      .prepare<{ pm_id: string; ts: number; nav_usd: number }, [string]>(
        `SELECT pm_id, MAX(ts_ms) AS ts, nav_usd FROM pnl_ticks
         WHERE pool_id = ?
         GROUP BY pm_id`,
      )
      .all(poolId);
    const latestByPm = new Map(latests.map((r) => [r.pm_id, r]));

    let baseNav = 0;
    let latestNav = 0;
    for (const b of bases) {
      // Coverage guard per PM: the window must reach back at least 20h, or a
      // freshly-tracked PM would fake a near-zero PnL over a tiny window.
      if (now - b.ts < MIN_COVERAGE_MS) return null;
      const l = latestByPm.get(b.pm_id);
      if (!l) return null;
      baseNav += b.nav_usd;
      latestNav += l.nav_usd;
    }
    if (!Number.isFinite(baseNav) || baseNav <= 0 || !Number.isFinite(latestNav)) return null;

    return (latestNav - baseNav) / baseNav;
  };

  return {
    computeNavUsd,
    valuePhysicalUsd: valueUsd,
    recordTick,
    get24hPnlPct,
    snapshotEntry,
    computeIlUsd,
    attributor,
  };
}
