/**
 * Effective-execution-price helpers for DLMM LP orders.
 *
 * Worked example (from spec):
 *   LP order placed at bin price 100000 (coinB per coinA), pool fee = 40 bps.
 *   A taker selling A for B pays 40 bps of friction, so the taker must offer
 *   a market price of 100400 before our LP order fills.
 *   Conversely, a taker buying A with B needs the market price to drop to 99600.
 *
 * Precision note: all arithmetic is done in integer math scaled by 10_000 to
 * avoid any floating-point rounding. The output is then formatted back to the
 * same decimal string representation as the input (up to 8 decimal places).
 * Inputs whose fractional part exceeds 8 places are truncated, not rounded.
 */

export type Side = "sell" | "buy";

/**
 * Given an LP-order price `binPrice` (decimal string, coinB-per-coinA) and a
 * pool fee in basis points, return the taker-side market price that must be
 * reached for this order to fill.
 *
 *   sell (LP holds A, waiting to sell):  effective = binPrice × (10000 + feeBps) / 10000
 *   buy  (LP holds B, waiting to buy A): effective = binPrice × (10000 - feeBps) / 10000
 *
 * Pure integer arithmetic: we scale the price by 10^8 to preserve 8 decimal
 * places, apply the fee multiplier as an integer ratio, then format back out.
 */
export function effectiveFillPrice(binPrice: string, side: Side, feeBps: number): string {
  // Parse the decimal string into an integer scaled by 10^8.
  const [intPart = "0", fracPart = ""] = binPrice.split(".");
  const fracPadded = fracPart.padEnd(8, "0").slice(0, 8);
  const scaled = BigInt(intPart) * 100_000_000n + BigInt(fracPadded);

  // Apply fee as an exact rational: multiply by (10000 ± feeBps), then divide by 10000.
  const feeBig = BigInt(feeBps);
  const numerator = side === "sell" ? 10_000n + feeBig : 10_000n - feeBig;
  const result = (scaled * numerator) / 10_000n; // integer division — truncates

  // Format back to a decimal string with up to 8 decimal places.
  const intResult = result / 100_000_000n;
  const fracResult = result % 100_000_000n;
  const fracStr = fracResult.toString().padStart(8, "0").replace(/0+$/, "");
  return fracStr.length > 0 ? `${intResult}.${fracStr}` : intResult.toString();
}

/**
 * Partition a list of bin ids into those that are strictly below the active bin
 * (sell side — the LP is selling A, so these bins hold only A) and those that
 * are at-or-above the active bin (buy side — holds only B).
 *
 * The active bin itself is included in `buyBins` because the active bin can
 * hold both tokens; it is the bin takers are currently swapping through, and
 * our LP position there behaves as a resting buy for A.
 */
export function classifyBinsBySide(
  bins: number[],
  activeBinId: number,
): { sellBins: number[]; buyBins: number[] } {
  const sellBins: number[] = [];
  const buyBins: number[] = [];
  for (const id of bins) {
    if (id < activeBinId) {
      sellBins.push(id);
    } else {
      buyBins.push(id);
    }
  }
  return { sellBins, buyBins };
}
