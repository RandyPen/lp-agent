/**
 * Inventory correction.
 *
 * Given PM balances + target weights computed by the diff planner, computes
 * the inventory skew (SUI vs USDC imbalance) and adjusts target weights /
 * amounts so the plan doesn't require swaps the agent cannot perform.
 *
 * The CDPM agent can only add/remove liquidity — it cannot swap. Inventory
 * correction ensures the plan stays within the agent's action space by:
 *   - Scaling down the overage side's bins (less supply of the overweight token)
 *   - Scaling up the underweight side's bins (more supply where possible)
 *
 * Per decision-engine-design.md §4.1:
 *   |overage| < 0.15          normal (no correction)
 *   0.15 ≤ |overage| < 0.30   imbalanced side × 0.7, other side × 1.5
 *   0.30 ≤ |overage| < 0.50   stop placing new orders on the imbalanced side
 *   |overage| ≥ 0.50          single-sided only (forced bypass of gas filter)
 *
 * All functions are pure: no DB, no network, no Date.now().
 * bigint-safe throughout.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InventoryState {
  /**
   * Available coinA (base token, e.g. SUI) in raw units.
   * Includes PM balance + any fee bag amounts.
   */
  availableA: bigint;
  /**
   * Available coinB (quote token, e.g. USDC) in raw units.
   * Includes PM balance + any fee bag amounts.
   */
  availableB: bigint;
  /** Mid-price as a plain number (coinB per coinA), used to convert to a common unit. */
  midPriceNum: number;
  /** Decimal adjustment: 10^(decimalsA - decimalsB). */
  decimalAdj: number;
}

/**
 * Inventory overage classification.
 * overage > 0 → holding too much coinA (base/SUI)
 * overage < 0 → holding too much coinB (quote/USDC)
 */
export type InventoryRegime =
  | "balanced"      // |overage| < 0.15
  | "mild"          // 0.15 ≤ |overage| < 0.30
  | "moderate"      // 0.30 ≤ |overage| < 0.50
  | "severe";       // |overage| ≥ 0.50

/**
 * Adjustment factors produced by computeInventoryAdjustment.
 * Applied to the amount split: multiply bid amounts by bidScale, ask amounts by askScale.
 *
 * Convention:
 *   bid bins (k < active) consume coinA → bidScale applies to coinA allocation
 *   ask bins (k > active) consume coinB → askScale applies to coinB allocation
 */
export interface InventoryAdjustment {
  /** Scaling factor for bid-side (coinA) amounts. Range [0, ∞). */
  bidScale: number;
  /** Scaling factor for ask-side (coinB) amounts. Range [0, ∞). */
  askScale: number;
  regime: InventoryRegime;
  /** Signed overage in [-1, 1]: positive = too much coinA. */
  suiOverage: number;
  /** When true, only the under-stocked side should place orders. */
  singleSidedOnly: boolean;
  /** When true, the gas filter should be bypassed for this correction pass. */
  bypassGasFilter: boolean;
}

// ---------------------------------------------------------------------------
// Core computation
// ---------------------------------------------------------------------------

/**
 * Compute the SUI overage (signed) given available balances.
 *
 * sui_overage = SUI_value / total_value - 0.5
 *
 * Returns NaN when total_value is zero (caller should treat as "balanced" or
 * skip entirely when there is no capital to deploy).
 */
export function computeSuiOverage(inv: InventoryState): number {
  if (inv.midPriceNum <= 0 || !Number.isFinite(inv.midPriceNum)) return 0;
  if (inv.decimalAdj <= 0 || !Number.isFinite(inv.decimalAdj)) return 0;

  // Convert coinA to coinB-equivalent value:
  //   suiValueInB = availableA × midPrice / decimalAdj
  // (midPrice is coinB/coinA in human units; dividing by decimalAdj removes
  // the decimal-shift applied to get human prices from raw amounts.)
  const suiValueInB_f =
    (Number(inv.availableA) * inv.midPriceNum) / inv.decimalAdj;
  const bValue_f = Number(inv.availableB);
  const totalValue_f = suiValueInB_f + bValue_f;

  if (totalValue_f <= 0) return 0;

  return suiValueInB_f / totalValue_f - 0.5;
}

/**
 * Classify the overage into one of the four regimes.
 */
export function classifyOverage(overage: number): InventoryRegime {
  const abs = Math.abs(overage);
  if (abs < 0.15) return "balanced";
  if (abs < 0.30) return "mild";
  if (abs < 0.50) return "moderate";
  return "severe";
}

/**
 * Compute bid/ask scaling factors for the inventory imbalance.
 *
 * overage > 0 → too much SUI (coinA) → scale down bid side (don't deploy more SUI),
 *               scale up ask side (use USDC aggressively).
 * overage < 0 → too much USDC (coinB) → scale down ask side, scale up bid side.
 */
export function computeInventoryAdjustment(inv: InventoryState): InventoryAdjustment {
  const overage = computeSuiOverage(inv);
  const regime = classifyOverage(overage);

  switch (regime) {
    case "balanced":
      return {
        bidScale: 1,
        askScale: 1,
        regime,
        suiOverage: overage,
        singleSidedOnly: false,
        bypassGasFilter: false,
      };

    case "mild": {
      // Overage side × 0.7, other side × 1.5
      const bidScale = overage > 0 ? 0.7 : 1.5;
      const askScale = overage < 0 ? 0.7 : 1.5;
      return {
        bidScale,
        askScale,
        regime,
        suiOverage: overage,
        singleSidedOnly: false,
        bypassGasFilter: false,
      };
    }

    case "moderate":
      // Stop new orders on the imbalanced side.
      return {
        bidScale: overage > 0 ? 0 : 1,  // too much SUI → no new bid orders
        askScale: overage < 0 ? 0 : 1,   // too much USDC → no new ask orders
        regime,
        suiOverage: overage,
        singleSidedOnly: false,
        bypassGasFilter: false,
      };

    case "severe":
      // Single-sided only, bypass gas filter.
      return {
        bidScale: overage > 0 ? 0 : 1,
        askScale: overage < 0 ? 0 : 1,
        regime,
        suiOverage: overage,
        singleSidedOnly: true,
        bypassGasFilter: true,
      };
  }
}

/**
 * Apply inventory adjustment scales to per-bin amount arrays.
 *
 * Inputs:
 *   bins        — bin ids (sorted ascending)
 *   amountsA    — coinA amounts per bin (bid side bins have non-zero A; ask side = 0)
 *   amountsB    — coinB amounts per bin (ask side bins have non-zero B; bid side = 0)
 *   activeBin   — current pool active bin (for side classification)
 *   adj         — adjustment from computeInventoryAdjustment
 *
 * Outputs:
 *   Adjusted amountsA / amountsB (same length, non-negative bigints).
 *   The function never introduces new negative values or overflows.
 *   Total amounts are scaled down but never scaled up beyond the input total
 *   (we scale by floor to stay bigint-safe; the adjustment is always [0,1]
 *   for the reduced side and >1 for the boosted side capped by available balance).
 *
 * Note: scaling up (× 1.5) can exceed the available balance. The caller must
 * clamp to available after this call. Here we apply the factor as specified
 * and let the caller decide how to clamp.
 */
export function applyInventoryScales(
  bins: number[],
  amountsA: bigint[],
  amountsB: bigint[],
  activeBin: number,
  adj: InventoryAdjustment,
): { adjustedA: bigint[]; adjustedB: bigint[] } {
  if (bins.length !== amountsA.length || bins.length !== amountsB.length) {
    throw new Error(
      `applyInventoryScales: length mismatch bins=${bins.length} A=${amountsA.length} B=${amountsB.length}`,
    );
  }

  const SCALE = 1_000_000n; // 6-digit fixed-point precision
  const bidScaleFixed = BigInt(Math.round(adj.bidScale * Number(SCALE)));
  const askScaleFixed = BigInt(Math.round(adj.askScale * Number(SCALE)));

  const adjustedA = amountsA.map((a, i) => {
    if (a === 0n) return 0n;
    const k = bins[i]!;
    if (k >= activeBin) return a; // ask-side bin, A should be 0 anyway
    // bid-side: apply bidScale
    const scaled = (a * bidScaleFixed) / SCALE;
    return scaled < 0n ? 0n : scaled;
  });

  const adjustedB = amountsB.map((b, i) => {
    if (b === 0n) return 0n;
    const k = bins[i]!;
    if (k < activeBin) return b; // bid-side bin, B should be 0 anyway
    // ask-side: apply askScale
    const scaled = (b * askScaleFixed) / SCALE;
    return scaled < 0n ? 0n : scaled;
  });

  return { adjustedA, adjustedB };
}

/**
 * Clamp per-bin amounts so the sum does not exceed the available balance.
 * Distributes the clamping proportionally across bins to preserve relative weights.
 *
 * This is a safety net for the scale-up (× 1.5) path where the adjusted
 * amounts may exceed what the PM actually holds.
 */
export function clampToAvailable(
  amountsA: bigint[],
  amountsB: bigint[],
  availableA: bigint,
  availableB: bigint,
): { clampedA: bigint[]; clampedB: bigint[] } {
  const clamp = (amounts: bigint[], available: bigint): bigint[] => {
    const total = amounts.reduce((s, v) => s + v, 0n);
    if (total <= available || total === 0n) return amounts;

    // Scale each amount down proportionally using bigint arithmetic.
    // clampedAmount[i] = amounts[i] × available / total
    const scaled = amounts.map((a) => (a * available) / total);

    // Distribute rounding dust (total may be slightly less than available).
    let allocated = scaled.reduce((s, v) => s + v, 0n);
    if (allocated < available) {
      const dust = available - allocated;
      // Add dust to the largest bin.
      let maxIdx = 0;
      for (let i = 1; i < scaled.length; i++) {
        if ((scaled[i] ?? 0n) > (scaled[maxIdx] ?? 0n)) maxIdx = i;
      }
      scaled[maxIdx] = (scaled[maxIdx] ?? 0n) + dust;
      allocated += dust;
    }

    return scaled;
  };

  return {
    clampedA: clamp(amountsA, availableA),
    clampedB: clamp(amountsB, availableB),
  };
}
