/**
 * Cross-protocol lending whitelist + per-coin dust thresholds.
 *
 * Pattern mirrors cdpm_web/src/lib/lending-config.ts §"Lending opportunity
 * whitelist" + §"Per-underlying minimum lending delta". This module answers
 * two operational questions independently of the DLMM pool config:
 *
 *   1. **Can coin X earn yield at all?** — `canLend(coinType)`. Used by the
 *      router decision tree before considering supply / redeem decisions.
 *      Replaces the older `profile.lendingEligible.includes(coinType)`
 *      coupling that hard-wired lendable coins to whatever DLMM pool pairs
 *      were configured.
 *
 *   2. **What's the smallest amount worth lending?** — `getMinLendingDeltaRaw`.
 *      Below this threshold we skip emitting a lending plan to avoid paying
 *      gas on dust. Per-coin because decimals + unit price differ wildly
 *      (1 USDC raw ≪ 1 SUI raw ≪ 1 DEEP raw, etc).
 *
 * Adding a new lendable asset (operator runbook):
 *   1. Confirm the coin is whitelisted by Scallop (`query.getMarketPool('X')`)
 *      and/or has a Kai vault (`kaiVaults.ts` KAI_VAULTS).
 *   2. Add a row to `LENDING_OPPORTUNITIES` here for each (protocol, coin).
 *   3. Add a row to `MIN_LENDING_DELTA_RAW` here for the new coin's dust floor.
 *   4. For Kai: ensure the corresponding entry exists in `KAI_VAULTS`
 *      (`kaiVaults.ts`). For Scallop: pass the right `scallopCoinName`
 *      (SDK's coin key — `usdc`, `sui`, `deep`, etc.).
 *   5. Restart the agent. No schema change, no migration.
 */

import { normalizeStructTag } from "@mysten/sui/utils";
import type { LendingProtocol } from "./types.ts";

// =============================================================================
// Coin type constants
// =============================================================================
//
// Pinned to the canonical (long-form, case-preserving) representation that
// `normalizeStructTag` produces, so `canLend('0x2::sui::SUI')` matches
// `canLend('0x0000…0002::sui::SUI')` via `canonicalType`.
// Module and struct names retain their original casing (e.g. SUI, USDC, DEEP).

const USDC_TYPE =
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const SUI_TYPE =
  "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const DEEP_TYPE =
  "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP";

// =============================================================================
// Scallop mainnet constants
// =============================================================================
//
// Pinned snapshots from `https://sui.apis.scallop.io` (addressId
// `67c44a103fe1b8c454eb9699`) so PTB construction can work offline. If
// Scallop ships a Version upgrade these need to be refreshed. The runtime
// adapter `src/sui/lending/scallop.ts` also resolves these via SDK at first
// use — these constants are the offline fallback + dev sanity check.

export const SCALLOP_MAINNET = {
  PROTOCOL_PACKAGE_ID:
    "0xde5c09ad171544aa3724dc67216668c80e754860f419136a68d78504eb2e2805",
  VERSION_ID:
    "0x07871c4b3c847a0f674510d4978d5cf6f960452795e8ff6f189fd2088a3f6ac7",
  MARKET_ID:
    "0xa757975255146dc9686aa823b7838b507f315d704f428cbadad2f4ea061939d9",
  COIN_DECIMALS_REGISTRY_ID:
    "0x200abe9bf19751cc566ae35aa58e2b7e4ff688fc1130f8d8909ea09bc137d668",
} as const;

// =============================================================================
// Scallop per-coin BalanceSheet refs
// =============================================================================
//
// Each entry pins the per-coin `lendingPoolAddress` (Scallop BalanceSheet
// shared object). The on-chain `content.fields` of these objects exposes
// `cash`, `debt`, `market_coin_supply`, `revenue` (u64 strings) — enough to
// run the off-chain `scoinToBurnForTargetNet` inverse sizing in
// `src/sui/lending/math.ts` without round-tripping through the SDK.
//
// Today the router uses naive proportional redeem sizing (see project-overview
// §4.3). When we wire snapshot-based sizing in, callers can read these IDs
// from `getScallopReserveByUnderlying(coinType)`.
//
// Snapshot source: `https://sui.apis.scallop.io/pool/addresses`.

export interface ScallopReserveRef {
  underlyingType: string;
  /**
   * Scallop BalanceSheet shared object id (per-coin). The Move object's
   * `content.fields` exposes the four u64s needed for off-chain reserve
   * snapshot math.
   */
  lendingPoolAddress: string;
}

export const SCALLOP_RESERVES: ReadonlyArray<ScallopReserveRef> = [
  {
    underlyingType: USDC_TYPE,
    lendingPoolAddress:
      "0xd3be98bf540f7603eeb550c0c0a19dbfc78822f25158b5fa84ebd9609def415f",
  },
  {
    underlyingType: SUI_TYPE,
    lendingPoolAddress:
      "0x9c9077abf7a29eebce41e33addbcd6f5246a5221dd733e56ea0f00ae1b25c9e8",
  },
  {
    underlyingType: DEEP_TYPE,
    lendingPoolAddress:
      "0xf4a67ffb43da1e1c61c049f188f19463ea8dbbf2d5ef4722d6df854ff1b1cc03",
  },
];

// =============================================================================
// Lending opportunity whitelist
// =============================================================================

export interface LendingOpportunity {
  protocol: LendingProtocol;
  underlyingType: string;
  /**
   * APR floor (basis points) below which this opportunity is not used. The
   * router skips supply when `apy * 10_000 < minAprBps`. Operator can lower
   * to 0 to disable the gate.
   */
  minAprBps: number;
  /**
   * Scallop SDK coin key (e.g. 'usdc'). Required for Scallop entries.
   * Ignored for Kai entries — Kai's vault metadata in `kaiVaults.ts` carries
   * everything we need.
   */
  scallopCoinName?: string;
}

/**
 * v1 whitelist: USDC + SUI + DEEP at both Scallop and Kai. Matches cdpm_web's
 * mainnet subset for these three coins. WAL / HAEDAL (cdpm_web also lists
 * them) are deferred — we'd need to add them to `kaiVaults.ts` first if Kai
 * supports, and Scallop's SDK whitelist for them is partial.
 *
 * `minAprBps = 200` (2% APR) for Scallop and `300` (3% APR) for Kai reflects
 * the rough opportunity cost vs. gas — under these thresholds the round-trip
 * isn't worth it. Tune per market conditions.
 */
export const LENDING_OPPORTUNITIES: ReadonlyArray<LendingOpportunity> = [
  // Scallop
  { protocol: "scallop", underlyingType: USDC_TYPE, minAprBps: 200, scallopCoinName: "usdc" },
  { protocol: "scallop", underlyingType: SUI_TYPE,  minAprBps: 200, scallopCoinName: "sui"  },
  { protocol: "scallop", underlyingType: DEEP_TYPE, minAprBps: 200, scallopCoinName: "deep" },
  // Kai SAV
  { protocol: "kai", underlyingType: USDC_TYPE, minAprBps: 300 },
  { protocol: "kai", underlyingType: SUI_TYPE,  minAprBps: 300 },
  { protocol: "kai", underlyingType: DEEP_TYPE, minAprBps: 300 },
];

// =============================================================================
// Per-coin dust threshold
// =============================================================================
//
// Below this raw amount the router skips emitting a lending plan — gas would
// dominate the yield. cdpm_web's production sizing:
//   USDC (6 dec)   — 1.00 USDC
//   SUI  (9 dec)   — 1.00 SUI
//   DEEP (6 dec)   — 10.00 DEEP   (lower unit price, wider band)

export const MIN_LENDING_DELTA_RAW: Readonly<Record<string, bigint>> = {
  [USDC_TYPE]: 1_000_000n,         // 1 USDC
  [SUI_TYPE]:  1_000_000_000n,     // 1 SUI
  [DEEP_TYPE]: 10_000_000n,        // 10 DEEP
};

/**
 * Sentinel for un-configured coins. Returning `MAX_U64` means `delta < min`
 * is always true → orchestrator skips. Forces explicit registration before
 * any new coin participates in lending.
 */
const UNCONFIGURED_MIN = (1n << 64n) - 1n;

// =============================================================================
// Helpers (canonical-type normalised — `0x2::sui::SUI` == `0x000…02::sui::SUI`)
// =============================================================================

function canonical(coinType: string): string {
  try {
    return normalizeStructTag(coinType);
  } catch {
    return coinType.trim();
  }
}

/** Returns every (protocol, coin) opportunity for the given underlying. */
export function getCandidateOpportunities(
  underlyingType: string,
): LendingOpportunity[] {
  const key = canonical(underlyingType);
  return LENDING_OPPORTUNITIES.filter((o) => canonical(o.underlyingType) === key);
}

/**
 * Quick lendability check. The router uses this before considering any
 * supply / redeem decision; replaces the old `profile.lendingEligible`
 * coupling. Returns true iff there's at least one opportunity for the coin.
 */
export function canLend(underlyingType: string): boolean {
  const key = canonical(underlyingType);
  return LENDING_OPPORTUNITIES.some((o) => canonical(o.underlyingType) === key);
}

/**
 * Returns the per-coin dust threshold (raw u64 base units). For
 * un-registered coins returns `MAX_U64` so `delta < min` is always true.
 */
export function getMinLendingDeltaRaw(underlyingType: string): bigint {
  const key = canonical(underlyingType);
  for (const c of Object.keys(MIN_LENDING_DELTA_RAW)) {
    if (canonical(c) === key) return MIN_LENDING_DELTA_RAW[c]!;
  }
  return UNCONFIGURED_MIN;
}

/**
 * Returns the Scallop SDK coin key (e.g. `'usdc'`) for a given underlying,
 * or `null` when the coin isn't supplied to Scallop in our whitelist.
 */
export function getScallopCoinName(underlyingType: string): string | null {
  const key = canonical(underlyingType);
  const entry = LENDING_OPPORTUNITIES.find(
    (o) => o.protocol === "scallop" && canonical(o.underlyingType) === key,
  );
  return entry?.scallopCoinName ?? null;
}

/**
 * Returns the enabled protocols for a coin. e.g. `["scallop", "kai"]` for
 * USDC; `[]` for an unsupported coin.
 */
export function lendingProtocolsFor(underlyingType: string): LendingProtocol[] {
  return getCandidateOpportunities(underlyingType).map((o) => o.protocol);
}

/**
 * Returns the Scallop BalanceSheet shared object for the given underlying,
 * or `undefined` if not registered. Used when reading on-chain reserve
 * state offline (e.g., for `scoinToBurnForTargetNet` snapshot-based sizing).
 */
export function getScallopReserveByUnderlying(
  underlyingType: string,
): ScallopReserveRef | undefined {
  const key = canonical(underlyingType);
  return SCALLOP_RESERVES.find((r) => canonical(r.underlyingType) === key);
}
