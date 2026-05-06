/**
 * Thin wrappers over the Cetus DLMM SDK's BinUtils.
 *
 * All BinUtils methods that accept amounts expect strings; the SDK internally
 * uses arbitrary-precision arithmetic (BN.js). Methods that return a price or
 * Q64x64 value return strings from the SDK — we re-expose them as-is where the
 * contract type is string, and convert to bigint where the contract says bigint.
 *
 * Import note: the SDK has a single package export, no "/utils" sub-path.
 */
import { BinUtils } from "@cetusprotocol/dlmm-sdk";

/**
 * CDPM agents are capped at 70 bins per position NFT (the Cetus protocol
 * maximum is 1000, but the agent protocol enforces 70).
 */
export const MAX_BINS_PER_POSITION = 70;

/**
 * Human-readable decimal-adjusted price (coinB per coinA) for a given bin.
 * Delegates to BinUtils.getPriceFromBinId which returns a decimal string.
 */
export function priceFromBinId(
  binId: number,
  binStep: number,
  decimalsA: number,
  decimalsB: number,
): string {
  return BinUtils.getPriceFromBinId(binId, binStep, decimalsA, decimalsB);
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
  return BinUtils.getBinIdFromPrice(price, binStep, useFloor, decimalsA, decimalsB);
}

/**
 * Raw Q64x64 price for a bin, as a bigint.
 * BinUtils.getQPriceFromId returns a string; we normalise to bigint here so
 * callers never accidentally round-trip through Number.
 */
export function qPriceFromBinId(binId: number, binStep: number): bigint {
  const raw = BinUtils.getQPriceFromId(binId, binStep);
  return BigInt(raw);
}

/**
 * Liquidity L under the constant-sum formula: L = price·amountA + amountB.
 * `qPrice` is Q64x64 (the output of `qPriceFromBinId`); amounts are raw lamports.
 *
 * The SDK's getLiquidity accepts strings, so we convert and convert back.
 */
export function liquidityForAmounts(
  amountA: bigint,
  amountB: bigint,
  qPrice: bigint,
): bigint {
  const raw = BinUtils.getLiquidity(
    amountA.toString(),
    amountB.toString(),
    qPrice.toString(),
  );
  return BigInt(raw);
}

/**
 * How many CDPM position NFTs are required to cover [lowerBinId, upperBinId]
 * given the CDPM agent's 70-bin-per-position limit.
 *
 * Uses the SDK's getPositionCount which knows the same arithmetic, then clamps
 * to our MAX_BINS_PER_POSITION rather than the protocol max of 1000.
 */
export function positionsRequired(lowerBinId: number, upperBinId: number): number {
  const totalBins = upperBinId - lowerBinId + 1;
  return Math.ceil(totalBins / MAX_BINS_PER_POSITION);
}
