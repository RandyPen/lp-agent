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

// ---------------------------------------------------------------------------
// Pool orientation — physical bin space ↔ human pair price
// ---------------------------------------------------------------------------

/**
 * Everything needed to map between bin ids and the human pair price
 * (quote-per-base, the `spot.price` convention) for one pool.
 *
 * Physical facts (verified on mainnet, scripts/probe-bin-orientation.ts):
 *   - bin price = physical coinB per physical coinA (raw, rises with bin id);
 *   - bins ABOVE the active bin hold physical coinA only;
 *   - bins BELOW hold physical coinB only.
 *
 * When `poolCoinAIsQuote` is true the human price is the INVERSE of the bin
 * price, so the human price FALLS as bin id rises — every direction-sensitive
 * decision (trend skew, center shift, ask-side identification) must go
 * through these helpers instead of assuming "bin up = price up".
 */
export interface PoolOrientation {
  binStep: number;
  poolCoinADecimals: number;
  poolCoinBDecimals: number;
  poolCoinAIsQuote: boolean;
}

/** Extract the orientation facts from a PoolProfile-shaped object. */
export function orientationOf(profile: {
  binStep: number;
  decimalsA: number;
  decimalsB: number;
  poolCoinADecimals?: number;
  poolCoinBDecimals?: number;
  poolCoinAIsQuote?: boolean;
}): PoolOrientation {
  return {
    binStep: profile.binStep,
    poolCoinADecimals: profile.poolCoinADecimals ?? profile.decimalsA,
    poolCoinBDecimals: profile.poolCoinBDecimals ?? profile.decimalsB,
    poolCoinAIsQuote: profile.poolCoinAIsQuote ?? false,
  };
}

/**
 * Human pair price (quote-per-base — the `spot.price` / Binance convention)
 * at a bin's mid-point.
 */
export function humanPriceForBin(o: PoolOrientation, binId: number): number {
  const ratio = Math.pow(1 + o.binStep / BASIS_POINT_MAX, binId);
  return o.poolCoinAIsQuote
    ? Math.pow(10, o.poolCoinBDecimals - o.poolCoinADecimals) / ratio
    : ratio * Math.pow(10, o.poolCoinADecimals - o.poolCoinBDecimals);
}

/**
 * +1 when the human pair price RISES with bin id; −1 when it falls
 * (physical coinA is the quote asset).
 */
export function binDirection(o: PoolOrientation): 1 | -1 {
  return o.poolCoinAIsQuote ? -1 : 1;
}

/**
 * Nearest bin id for a HUMAN pair price (quote-per-base), orientation-aware —
 * the inverse of `humanPriceForBin` (rounded to the nearest bin).
 */
export function binIdForHumanPrice(o: PoolOrientation, price: number): number {
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`binIdForHumanPrice: invalid price ${price}`);
  }
  const logStep = Math.log(1 + o.binStep / BASIS_POINT_MAX);
  const ratio = o.poolCoinAIsQuote
    ? Math.pow(10, o.poolCoinBDecimals - o.poolCoinADecimals) / price
    : price * Math.pow(10, o.poolCoinBDecimals - o.poolCoinADecimals);
  return Math.round(Math.log(ratio) / logStep);
}

/**
 * Which PHYSICAL coin a non-active bin holds: bins above active hold coinA,
 * bins below hold coinB. Throws on the active bin itself — the agent never
 * places liquidity there (composition-fee policy).
 */
export function physicalSideForBin(binId: number, activeBinId: number): "A" | "B" {
  if (binId === activeBinId) {
    throw new Error(`physicalSideForBin: bin ${binId} IS the active bin — no single-coin side`);
  }
  return binId > activeBinId ? "A" : "B";
}
