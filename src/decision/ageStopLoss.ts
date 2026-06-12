/**
 * Position-age stop-loss (老化库存止损).
 *
 * Tracks per-bin (or per-lot) age from PM state + persisted timestamps passed
 * in by the caller. Emits "should liquidate stale one-sided position" decisions
 * without any DB access — purely functional over its inputs.
 *
 * Design reference: decision-engine-design.md §4.2:
 *   age > 4h  and unrealized loss > 3 %  → relax ask floor: binPrice = cost × 1.005
 *   age > 12h and unrealized loss > 5 %  → forced liquidation: ask at active + 1
 *
 * Note: "unrealized loss" in the context of a one-sided position means the
 * current bin price has moved below the cost basis (for bid side) or above
 * the cost basis (for ask side). We approximate the current value using the
 * mid-price of the bin relative to the active bin.
 *
 * All functions are pure: no Date.now() — callers pass `nowMs`.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A lot record: a batch of coin acquired at a specific time and price.
 * Created when liquidity is added to a bin; persisted externally (by the
 * position state DB layer — not this module).
 */
export interface LotRecord {
  /** Bin ID where this lot is parked. */
  binId: number;
  /** Epoch ms when the liquidity was added. */
  acquiredAtMs: number;
  /**
   * Cost basis in coinB-per-coinA human price at time of entry.
   * For bid lots (coinA held): cost = price paid per A in B terms.
   * For ask lots (coinB held): cost = price received per A in B terms.
   */
  costBasis: number;
  /**
   * Nominal amount in raw units (coinA for bid, coinB for ask).
   * Used only for sizing; stop-loss logic is per-lot not aggregate.
   */
  amount: bigint;
}

/**
 * Current price context needed for age stop-loss evaluation.
 * The caller provides these values; this module does not query the chain.
 */
export interface PriceContext {
  /** Current pool active bin ID. */
  activeBin: number;
  /**
   * Mid-price of the active bin as a plain number (coinB per coinA).
   * Used to estimate the current mark-to-market for each lot.
   */
  currentMidPrice: number;
  /** Pool bin step in basis points (needed to price adjacent bins). */
  binStep: number;
}

/**
 * Decision emitted for a single lot after age stop-loss evaluation.
 */
export type AgeStopLossDecision =
  | {
      kind: "hold";
      binId: number;
      lotIdx: number;
    }
  | {
      /** Relax the ask floor: effective ask price becomes cost × 1.005. */
      kind: "relax_ask_floor";
      binId: number;
      lotIdx: number;
      relaxedAskBinId: number;
      reason: string;
    }
  | {
      /** Forced liquidation: move ask to active + 1. */
      kind: "force_liquidate";
      binId: number;
      lotIdx: number;
      forcedAskBinId: number;
      reason: string;
    };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 4-hour age threshold (ms) for relaxed ask floor. */
const AGE_4H_MS = 4 * 60 * 60 * 1000;

/** 12-hour age threshold (ms) for forced liquidation. */
const AGE_12H_MS = 12 * 60 * 60 * 1000;

/** Unrealized loss threshold for 4h regime (3 %). */
const LOSS_3_PCT = 0.03;

/** Unrealized loss threshold for 12h regime (5 %). */
const LOSS_5_PCT = 0.05;

/** Relaxed ask floor: cost × 1.005. */
const RELAX_ASK_FACTOR = 1.005;

// ---------------------------------------------------------------------------
// Core evaluation logic
// ---------------------------------------------------------------------------

/**
 * Estimate the current bin mid-price relative to the active bin.
 *
 * price(k) ≈ currentMidPrice × (1 + binStepBps/10000)^(k - activeBin)
 * This geometric approximation matches priceFromBinId for nearby bins.
 */
export function estimateBinPrice(
  binId: number,
  priceCtx: PriceContext,
): number {
  const step = priceCtx.binStep / 10_000;
  const offset = binId - priceCtx.activeBin;
  return priceCtx.currentMidPrice * Math.pow(1 + step, offset);
}

/**
 * Compute the unrealized loss fraction for a bid lot.
 *
 * A bid lot holds coinA. Loss occurs when the current bin price has fallen
 * below the cost basis:
 *   unrealizedLoss = max(0, (costBasis - currentBinPrice) / costBasis)
 */
export function bidLotLoss(lot: LotRecord, priceCtx: PriceContext): number {
  if (lot.costBasis <= 0) return 0;
  const currentPrice = estimateBinPrice(lot.binId, priceCtx);
  return Math.max(0, (lot.costBasis - currentPrice) / lot.costBasis);
}

/**
 * Compute the unrealized loss fraction for an ask lot.
 *
 * An ask lot holds coinB and waits to sell coinA. The cost basis is the price
 * at which the LP accepted coinB (i.e., the lot was placed above active when
 * coinA was sold for coinB). Loss occurs when the current price has risen
 * above the cost basis (the LP is holding USDC while SUI price went up —
 * opportunity cost / impermanent loss):
 *   unrealizedLoss = max(0, (currentBinPrice - costBasis) / costBasis)
 */
export function askLotLoss(lot: LotRecord, priceCtx: PriceContext): number {
  if (lot.costBasis <= 0) return 0;
  const currentPrice = estimateBinPrice(lot.binId, priceCtx);
  return Math.max(0, (currentPrice - lot.costBasis) / lot.costBasis);
}

/**
 * Identify which bin ID the "relaxed ask floor" maps to.
 *
 * relaxedAskPrice = cost × 1.005
 * We find the nearest bin above the active bin whose price >= relaxedAskPrice.
 * Returns activeBin + 1 as minimum (can't be on or below active).
 */
export function relaxedAskBinId(
  costBasis: number,
  priceCtx: PriceContext,
): number {
  const targetPrice = costBasis * RELAX_ASK_FACTOR;
  const step = priceCtx.binStep / 10_000;

  // Geometric: k = activeBin + ceil(log(target/current) / log(1+step))
  if (priceCtx.currentMidPrice <= 0 || !Number.isFinite(priceCtx.currentMidPrice)) {
    return priceCtx.activeBin + 1;
  }
  const ratio = targetPrice / priceCtx.currentMidPrice;
  if (ratio <= 1) return priceCtx.activeBin + 1;
  const offset = Math.ceil(Math.log(ratio) / Math.log(1 + step));
  return priceCtx.activeBin + Math.max(1, offset);
}

/**
 * Evaluate age stop-loss for a single lot.
 *
 * The caller provides `nowMs` (no Date.now() inside this module).
 *
 * For bid lots (binId < activeBin): loss = price decline below cost.
 * For ask lots (binId > activeBin): loss = price rise above cost (opportunity).
 */
export function evaluateLot(
  lot: LotRecord,
  lotIdx: number,
  priceCtx: PriceContext,
  nowMs: number,
): AgeStopLossDecision {
  const ageMs = nowMs - lot.acquiredAtMs;
  if (ageMs < 0) {
    // Future timestamp: treat as brand new.
    return { kind: "hold", binId: lot.binId, lotIdx };
  }

  const isBidLot = lot.binId < priceCtx.activeBin;
  const loss = isBidLot ? bidLotLoss(lot, priceCtx) : askLotLoss(lot, priceCtx);

  // 12h forced liquidation check.
  if (ageMs >= AGE_12H_MS && loss > LOSS_5_PCT) {
    const forcedAskBinId = priceCtx.activeBin + 1;
    return {
      kind: "force_liquidate",
      binId: lot.binId,
      lotIdx,
      forcedAskBinId,
      reason: `age=${Math.round(ageMs / 3600_000)}h loss=${(loss * 100).toFixed(1)}% > 5% — forced liquidation at active+1`,
    };
  }

  // 4h relaxed ask floor check.
  if (ageMs >= AGE_4H_MS && loss > LOSS_3_PCT) {
    const askBinId = relaxedAskBinId(lot.costBasis, priceCtx);
    return {
      kind: "relax_ask_floor",
      binId: lot.binId,
      lotIdx,
      relaxedAskBinId: askBinId,
      reason: `age=${Math.round(ageMs / 3600_000)}h loss=${(loss * 100).toFixed(1)}% > 3% — relaxed ask floor at bin ${askBinId}`,
    };
  }

  return { kind: "hold", binId: lot.binId, lotIdx };
}

/**
 * Evaluate all lots and return the aggregate set of decisions.
 *
 * Returns one decision per lot, in input order. The caller can then filter
 * for non-"hold" decisions to decide whether to include forced/relaxed bins
 * in the rebalance plan.
 *
 * Forced liquidations bypass the gas filter and ask-min filter (per
 * decision-engine-design.md §4.2 exception clause).
 */
export function evaluateAllLots(
  lots: LotRecord[],
  priceCtx: PriceContext,
  nowMs: number,
): AgeStopLossDecision[] {
  return lots.map((lot, idx) => evaluateLot(lot, idx, priceCtx, nowMs));
}

/**
 * Determine whether the position has any bins that should trigger an
 * immediate stop-loss action (either relax_ask_floor or force_liquidate).
 *
 * Convenience wrapper used by the mlAgent orchestration layer to decide
 * whether to force a rebalance outside the normal schedule.
 */
export function shouldTriggerStopLoss(decisions: AgeStopLossDecision[]): boolean {
  return decisions.some((d) => d.kind !== "hold");
}

/**
 * Extract all force_liquidate decisions from a decision array.
 * These should bypass gas and ask-min filters.
 */
export function getForceLiquidations(
  decisions: AgeStopLossDecision[],
): Extract<AgeStopLossDecision, { kind: "force_liquidate" }>[] {
  return decisions.filter(
    (d): d is Extract<AgeStopLossDecision, { kind: "force_liquidate" }> =>
      d.kind === "force_liquidate",
  );
}
