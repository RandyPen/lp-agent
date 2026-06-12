/**
 * src/risk/pnlAttribution.ts
 *
 * PnL attribution skeleton (W7 deliverable per implementation-plan-v1.md).
 *
 * Records per-tick PnL components in memory and provides a `summarize`
 * aggregation. No new SQLite tables — the spec permits computing from existing
 * `rebalances` and `lending_actions` tables, but this module keeps everything
 * in-memory for speed; the `summarize()` output is intended for reports and
 * the shadow-mode diagnostic log, not direct DB persistence.
 *
 * Component breakdown per risk-monitoring-design.md §七:
 *   feeIncome       — swap fees collected from the pool position
 *   rebalanceCost   — estimated gas + treasury service cost per rebalance
 *   inventoryDelta  — mark-to-market change in position inventory value
 *
 * See docs/risk-monitoring-design.md §七.2 and implementation-plan-v1.md §W7.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PnlTick {
  /** Pool ID this tick belongs to. */
  poolId: string;
  /** Epoch ms of this tick. */
  ts: number;
  /**
   * Swap fees collected in this tick (USD equivalent).
   * Positive = income.
   */
  feeIncome: number;
  /**
   * Estimated cost of the rebalance in this tick (gas + treasury service fee),
   * expressed as a positive USD value. 0 when no rebalance occurred.
   */
  rebalanceCost: number;
  /**
   * Change in position inventory value since the previous tick (USD).
   * Positive = inventory appreciated; negative = inventory lost value
   * (unrealised loss from price movement against held inventory).
   */
  inventoryDelta: number;
  /**
   * Market state at the time of this tick (from the state machine).
   * Stored to enable per-state breakdown in `summarize()`.
   */
  marketState: "NORMAL" | "TREND" | "EXTREME" | null;
}

export interface PnlSummary {
  poolId: string;
  sinceMs: number;
  untilMs: number;
  tickCount: number;
  /** Total fee income (USD) over the window. */
  totalFeeIncome: number;
  /** Total rebalance costs (USD) over the window. */
  totalRebalanceCost: number;
  /** Net inventory delta (USD) — sum of unrealised mark-to-market changes. */
  totalInventoryDelta: number;
  /** Net PnL = feeIncome - rebalanceCost + inventoryDelta. */
  netPnl: number;
  /** Per-state breakdown. */
  byState: Record<"NORMAL" | "TREND" | "EXTREME" | "unknown", StateSummary>;
}

export interface StateSummary {
  tickCount: number;
  feeIncome: number;
  rebalanceCost: number;
  inventoryDelta: number;
  netPnl: number;
}

export interface PnlAttributor {
  /**
   * Record a single tick's PnL components.
   * Thread-safe in the sense that Bun is single-threaded; no explicit locking needed.
   */
  record(tick: PnlTick): void;
  /**
   * Summarise PnL for `poolId` from `sinceMs` up to (not including) `untilMs`.
   * If `untilMs` is omitted, defaults to now.
   */
  summarize(poolId: string, sinceMs: number, untilMs?: number): PnlSummary;
  /** Return all ticks for `poolId` in chronological order, optionally filtered. */
  ticks(poolId: string, sinceMs?: number, untilMs?: number): PnlTick[];
  /** Evict ticks older than `olderThanMs` to bound memory usage. */
  evictBefore(olderThanMs: number): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface PnlAttributorDeps {
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  nowMs?: () => number;
  /**
   * Maximum number of ticks to retain per pool before automatic eviction
   * of the oldest entries. 0 = no automatic eviction. Default 10_000.
   */
  maxTicksPerPool?: number;
}

const ZERO_STATE: StateSummary = Object.freeze({
  tickCount: 0,
  feeIncome: 0,
  rebalanceCost: 0,
  inventoryDelta: 0,
  netPnl: 0,
});

/**
 * Create an in-memory PnL attributor.
 */
export function createPnlAttributor(deps: PnlAttributorDeps = {}): PnlAttributor {
  const nowMs = deps.nowMs ?? (() => Date.now());
  const maxTicks = deps.maxTicksPerPool ?? 10_000;

  // poolId → chronologically ordered ticks
  const store = new Map<string, PnlTick[]>();

  function getOrCreate(poolId: string): PnlTick[] {
    let arr = store.get(poolId);
    if (!arr) {
      arr = [];
      store.set(poolId, arr);
    }
    return arr;
  }

  function record(tick: PnlTick): void {
    const arr = getOrCreate(tick.poolId);
    arr.push(tick);
    // Evict oldest entries when over limit
    if (maxTicks > 0 && arr.length > maxTicks) {
      arr.splice(0, arr.length - maxTicks);
    }
  }

  function ticks(poolId: string, sinceMs?: number, untilMs?: number): PnlTick[] {
    const arr = store.get(poolId);
    if (!arr) return [];
    const lo = sinceMs ?? 0;
    const hi = untilMs ?? Infinity;
    return arr.filter((t) => t.ts >= lo && t.ts < hi);
  }

  function summarize(poolId: string, sinceMs: number, untilMs?: number): PnlSummary {
    const until = untilMs ?? nowMs();
    const window = ticks(poolId, sinceMs, until);

    type StateKey = "NORMAL" | "TREND" | "EXTREME" | "unknown";
    const byState: Record<StateKey, StateSummary> = {
      NORMAL: { ...ZERO_STATE },
      TREND: { ...ZERO_STATE },
      EXTREME: { ...ZERO_STATE },
      unknown: { ...ZERO_STATE },
    };

    let totalFeeIncome = 0;
    let totalRebalanceCost = 0;
    let totalInventoryDelta = 0;

    for (const tick of window) {
      const stateKey: StateKey = tick.marketState ?? "unknown";
      const bucket = byState[stateKey];
      bucket.tickCount++;
      bucket.feeIncome += tick.feeIncome;
      bucket.rebalanceCost += tick.rebalanceCost;
      bucket.inventoryDelta += tick.inventoryDelta;
      bucket.netPnl += tick.feeIncome - tick.rebalanceCost + tick.inventoryDelta;

      totalFeeIncome += tick.feeIncome;
      totalRebalanceCost += tick.rebalanceCost;
      totalInventoryDelta += tick.inventoryDelta;
    }

    return {
      poolId,
      sinceMs,
      untilMs: until,
      tickCount: window.length,
      totalFeeIncome,
      totalRebalanceCost,
      totalInventoryDelta,
      netPnl: totalFeeIncome - totalRebalanceCost + totalInventoryDelta,
      byState,
    };
  }

  function evictBefore(olderThanMs: number): void {
    for (const [, arr] of store) {
      // Remove entries older than cutoff
      let i = 0;
      while (i < arr.length && arr[i]!.ts < olderThanMs) i++;
      if (i > 0) arr.splice(0, i);
    }
  }

  return { record, summarize, ticks, evictBefore };
}
