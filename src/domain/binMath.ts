/**
 * Bin ↔ price math for Cetus DLMM, pure TypeScript implementation.
 *
 * Formula (matches the DLMM constant-sum pricing scheme):
 *   rawPrice(binId) = (1 + binStep / BASIS_POINT_MAX)^binId
 *   humanPrice(binId) = rawPrice × 10^(decimalsA - decimalsB)
 *
 * The DLMM SDK (`@cetusprotocol/dlmm-sdk` v1.2.6) currently fails to load under
 * Bun due to an upstream `@cetusprotocol/common-sdk` API drift — using pure JS
 * here also removes a transitive runtime dependency from the read path. The
 * functions that *do* need bigint precision (e.g. `getLiquidity`) only matter
 * inside transaction-building paths, which already build raw move calls
 * without going through the SDK.
 *
 * Precision: JS Number gives ~15 significant digits which is far more than
 * the forecaster, strategy, or price-feed code paths require. For tx-building
 * paths that need Q64x64 precision, build them on-chain via `BinUtils` in the
 * Move runtime — never round-trip through JS Number.
 */

const BASIS_POINT_MAX = 10_000;

/**
 * CDPM agents are capped at 70 bins per position NFT (the Cetus protocol
 * maximum is 1000, but the agent protocol enforces 70).
 */
export const MAX_BINS_PER_POSITION = 70;

/** Human-readable decimal-adjusted price (coinB per coinA) for a given bin. */
export function priceFromBinId(
  binId: number,
  binStep: number,
  decimalsA: number,
  decimalsB: number,
): string {
  const ratio = Math.pow(1 + binStep / BASIS_POINT_MAX, binId);
  const decimalShift = Math.pow(10, decimalsA - decimalsB);
  const human = ratio * decimalShift;
  // Use enough digits to preserve precision for downstream string consumers.
  return human.toPrecision(15).replace(/\.?0+$/, "");
}

/**
 * Human-readable price as coinA-per-coinB (inverted from the standard formula).
 *
 * Use this when the DLMM pool's physical coinA is the quote asset and you want
 * the price expressed as "quote per base" (i.e. "coinA per coinB").
 *
 * Example: for a Pool<USDC=6, SUI=9> at binId=1442, binStep=50:
 *   raw ratio = 1.005^1442 ≈ 1328.8  (lamport-SUI per lamport-USDC)
 *   priceFromBinIdAsQuote(1442, 50, 6, 9)
 *     = 10^(9−6) / 1328.8 ≈ 0.7526  (USDC per SUI — Binance SUIUSDC convention)
 *
 * Formula: 10^(decimalsB − decimalsA) / (1 + binStep/10000)^binId
 */
export function priceFromBinIdAsQuote(
  binId: number,
  binStep: number,
  decimalsA: number,
  decimalsB: number,
): string {
  const ratio = Math.pow(1 + binStep / BASIS_POINT_MAX, binId);
  const decimalShift = Math.pow(10, decimalsB - decimalsA);
  const human = decimalShift / ratio;
  return human.toPrecision(15).replace(/\.?0+$/, "");
}

/**
 * Nearest bin id for a given decimal-adjusted price string.
 * `useFloor = true` rounds down (conservative lower bound);
 * `useFloor = false` rounds up (conservative upper bound).
 */
export function binIdFromPrice(
  price: string,
  binStep: number,
  useFloor: boolean,
  decimalsA: number,
  decimalsB: number,
): number {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) {
    throw new Error(`binIdFromPrice: invalid price '${price}'`);
  }
  const decimalShift = Math.pow(10, decimalsA - decimalsB);
  const ratio = p / decimalShift;
  const id = Math.log(ratio) / Math.log(1 + binStep / BASIS_POINT_MAX);
  return useFloor ? Math.floor(id) : Math.ceil(id);
}

/**
 * How many CDPM position NFTs are required to cover [lowerBinId, upperBinId]
 * given the CDPM agent's 70-bin-per-position limit.
 */
export function positionsRequired(lowerBinId: number, upperBinId: number): number {
  const totalBins = upperBinId - lowerBinId + 1;
  return Math.ceil(totalBins / MAX_BINS_PER_POSITION);
}
