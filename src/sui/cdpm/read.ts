import { getSuiClient } from "../client.ts";
import { OnchainFailureError, NoPositionError } from "../../lib/errors.ts";
import { log } from "../../lib/logger.ts";
import type { PMState, PositionBin } from "../../domain/types.ts";
import { emptyLendingState, type LendingState, type LendingPosition } from "../lending/types.ts";
import { getDb } from "../../db/client.ts";
import { loadConfig } from "../../config.ts";

// ---- I32 helpers ----

/**
 * The integer-mate I32 is stored as `{ bits: u32 }`. Reinterpret as a signed
 * 32-bit integer using two's-complement.
 */
function i32ToNumber(raw: unknown): number {
  const obj = raw as { bits: number };
  const bits = obj.bits >>> 0; // coerce to u32
  // If the high bit is set this is a negative number in two's complement.
  return bits & 0x8000_0000 ? bits - 0x1_0000_0000 : bits;
}

// ---- bag enumeration helpers ----

/**
 * Enumerate a Bag and return a map from coin-type string → raw u64 `value`
 * (as bigint). The bag dynamic fields use the ASCII coin-type string as the
 * key; each value is a Balance<T> containing a `value: u64`.
 *
 * If the bag object id is falsy (empty bag represented as just an id string),
 * an empty map is returned.
 */
async function readBagAmounts(bagId: string): Promise<Map<string, bigint>> {
  const client = getSuiClient();
  const result = new Map<string, bigint>();

  if (!bagId) return result;

  // Using `null` sentinel so TypeScript doesn't infer `page` as `any` from a
  // self-referential cursor type. We cast cursor to the SDK's expected type.
  let nextPageCursor: Parameters<typeof client.getDynamicFields>[0]["cursor"] = undefined;
  for (;;) {
    const page = await client.getDynamicFields({ parentId: bagId, cursor: nextPageCursor });
    for (const field of page.data) {
      // field.name.value is the coin-type ASCII string for Bag<String, Balance<T>>
      const coinType = String(field.name.value ?? "");
      if (!coinType) continue;

      const fieldObj = await client.getDynamicFieldObject({
        parentId: bagId,
        name: field.name,
      });
      // Balance<T> is surfaced as { fields: { value: "u64_string" } }
      const fieldContent = fieldObj.data?.content;
      if (!fieldContent || fieldContent.dataType !== "moveObject") continue;

      const fields = (fieldContent as { dataType: "moveObject"; fields: Record<string, unknown> }).fields;
      // The dynamic field value wraps Balance<T>; its `value` field holds the amount.
      // Actual path: fields.value.fields.value (outer field obj → inner Balance)
      const inner = fields["value"] as { fields?: { value?: unknown } } | undefined;
      const rawAmount = inner?.fields?.["value"] ?? fields["value"];
      if (rawAmount !== undefined && rawAmount !== null) {
        result.set(coinType, BigInt(rawAmount as string | number));
      }
    }
    if (!page.hasNextPage) break;
    nextPageCursor = page.nextCursor;
  }

  return result;
}

/** Normalize a coin-type tag: pad the address to 64 hex chars, lowercase. */
function normalizeCoinType(t: string): string {
  const [addr, ...rest] = t.split("::");
  if (!addr || !addr.startsWith("0x")) return t.toLowerCase();
  return ["0x" + addr.slice(2).padStart(64, "0"), ...rest].join("::").toLowerCase();
}

/** Bag lookup tolerant of short-form vs long-form address encodings. */
function lookupByNormalizedType(map: Map<string, bigint>, coinType: string): bigint {
  const direct = map.get(coinType);
  if (direct !== undefined) return direct;
  const want = normalizeCoinType(coinType);
  for (const [key, value] of map) {
    if (normalizeCoinType(key) === want) return value;
  }
  return 0n;
}

// ---- public API ----

/**
 * Fetch a PositionManager from chain and return a fully-populated PMState.
 *
 * Limitation (v0): per-bin amountA/amountB inside PositionBin are left as 0n.
 * Computing them requires simulating `refresh_position_info` against the pool,
 * which requires knowing the pool object and involves a devInspect call; that
 * is outside scope for this layer. Callers that need per-bin amounts should
 * use the separate simulation path.
 */
export async function getPositionManager(pmId: string): Promise<PMState> {
  const client = getSuiClient();

  log.debug("getPositionManager fetching", { pmId });

  const resp = await client.getObject({
    id: pmId,
    options: { showContent: true, showType: true },
  });

  if (!resp.data || resp.data.content?.dataType !== "moveObject") {
    throw new OnchainFailureError(`PositionManager ${pmId} not found or not a Move object`);
  }

  const fields = (
    resp.data.content as { dataType: "moveObject"; fields: Record<string, unknown> }
  ).fields;

  const owner = String(fields["owner"] ?? "");

  // agents: VecSet<address> is surfaced as { fields: { contents: [addresses] } }
  const agentsRaw = fields["agents"] as { fields?: { contents?: unknown[] } } | undefined;
  const agentContents: string[] = (agentsRaw?.fields?.contents ?? []).map((a) => String(a));

  // position: Option<Position>. When Some, Sui surfaces it as the inner object fields directly.
  // When None it is `null` or `{ type: "0x1::option::Option<...>", fields: { vec: [] } }`.
  const positionRaw = fields["position"] as
    | { fields?: { vec?: unknown[] } }
    | null
    | undefined;

  // Sui represents Option<T> as `{ vec: [] }` (None) or `{ vec: [T] }` (Some).
  const positionVec = positionRaw?.fields?.["vec"] as unknown[] | undefined ?? [];
  const positionInner = positionVec[0] as
    | {
        fields?: {
          pool_id?: unknown;
          lower_bin_id?: unknown;
          upper_bin_id?: unknown;
          liquidity_shares?: unknown[];
          coin_type_a?: unknown;
          coin_type_b?: unknown;
        };
      }
    | undefined;

  let poolId = "";
  let coinTypeA = "";
  let coinTypeB = "";
  const positionBins: PositionBin[] = [];

  if (positionInner?.fields) {
    const pf = positionInner.fields;
    poolId = String(pf.pool_id ?? "");
    // coin_type_a/b are std::ascii::String; Sui returns them as plain strings already.
    coinTypeA = String(pf.coin_type_a ?? "");
    coinTypeB = String(pf.coin_type_b ?? "");

    const lowerBinId = i32ToNumber(pf.lower_bin_id);
    const upperBinId = i32ToNumber(pf.upper_bin_id);

    const rawShares: unknown[] = pf.liquidity_shares ?? [];
    // liquidity_shares is vector<u128>; Sui surfaces u128 as decimal strings.
    const shares: bigint[] = rawShares.map((s) => BigInt(s as string | number));

    // Build a PositionBin for each bin in the range [lower, upper].
    // v0 limitation: amountA/amountB are left as 0n — computing them requires
    // simulating refresh_position_info against the live pool state.
    let shareIdx = 0;
    for (let binId = lowerBinId; binId <= upperBinId; binId++) {
      positionBins.push({
        binId,
        liquidityShare: shares[shareIdx] ?? 0n,
        amountA: 0n,
        amountB: 0n,
      });
      shareIdx++;
    }
  }

  // When no position is open, the position's coin_type_a/b are unavailable and
  // the balance-bag lookups below would key on "" — reading every balance as
  // 0n and making a funded-but-positionless PM look permanently empty (its
  // first-ever deploy would never fire). Fall back to the configured pool
  // profile's PHYSICAL coin order: physical A is the QUOTE-side logical coin
  // when poolCoinAIsQuote, else the base-side one.
  if (!coinTypeA || !coinTypeB) {
    const profile = loadConfig().poolProfile;
    const inverted = profile.poolCoinAIsQuote ?? false;
    coinTypeA = inverted ? profile.coinTypeB : profile.coinTypeA;
    coinTypeB = inverted ? profile.coinTypeA : profile.coinTypeB;
    log.debug("getPositionManager: no open position — using profile physical coin types", {
      pmId,
      coinTypeA,
      coinTypeB,
    });
  }

  // balance Bag
  const balanceBagRaw = fields["balance"] as { fields?: { id?: { id?: unknown } } } | undefined;
  const balanceBagId = String(
    balanceBagRaw?.fields?.id?.id ?? balanceBagRaw?.fields?.["id"] ?? "",
  );

  // fee Bag
  const feeBagRaw = fields["fee"] as { fields?: { id?: { id?: unknown } } } | undefined;
  const feeBagId = String(
    feeBagRaw?.fields?.id?.id ?? feeBagRaw?.fields?.["id"] ?? "",
  );

  const [balanceMap, feeMap] = await Promise.all([
    readBagAmounts(balanceBagId),
    readBagAmounts(feeBagId),
  ]);

  // The bag keys are the raw ASCII coin-type strings as Move emits them (e.g.
  // "0x2::sui::SUI"). Look up by NORMALIZED comparison (addresses padded to
  // 64 hex, lowercased) so the profile's long-form types and Move's short-form
  // keys still match — an exact-string miss here silently reads a funded
  // balance as 0n.
  const balA = lookupByNormalizedType(balanceMap, coinTypeA);
  const balB = lookupByNormalizedType(balanceMap, coinTypeB);
  const feeA = lookupByNormalizedType(feeMap, coinTypeA);
  const feeB = lookupByNormalizedType(feeMap, coinTypeB);

  log.debug("getPositionManager done", {
    pmId,
    poolId,
    positionBins: positionBins.length,
    balA,
    balB,
    feeA,
    feeB,
    agents: agentContents.length,
  });

  const lending = loadLendingState(pmId);

  return {
    pmId,
    owner,
    poolId,
    coinTypeA,
    coinTypeB,
    balance: { a: balA, b: balB },
    feeBag: { a: feeA, b: feeB },
    positionBins,
    lending,
  };
}

interface LendingPosRow {
  protocol: string;
  coin_type: string;
  yt_type: string;
  underlying_principal: string;
  market_coin_amount: string;
}

/**
 * Reconstruct LendingState for a PM from the local DB. Events are the source of truth
 * (kept up-to-date by subscriptions.ts); chain reads of the lending Bag would also work
 * but are heavier and not needed every tick.
 */
export function loadLendingState(pmId: string): LendingState {
  const state = emptyLendingState();
  let db;
  try {
    db = getDb();
  } catch {
    // DB not initialised yet (e.g. in unit tests reading a PM before openDb).
    return state;
  }
  const rows = db
    .query<LendingPosRow, [string]>(
      `SELECT protocol, coin_type, yt_type, underlying_principal, market_coin_amount
       FROM lending_positions WHERE pm_id = ?`,
    )
    .all(pmId);
  for (const row of rows) {
    if (row.protocol !== "scallop" && row.protocol !== "kai") continue;
    const pos: LendingPosition = {
      protocol: row.protocol,
      coinType: row.coin_type,
      ytType: row.yt_type,
      underlyingPrincipal: BigInt(row.underlying_principal),
      marketCoinAmount: BigInt(row.market_coin_amount),
    };
    state[pos.protocol][pos.coinType] = pos;
  }
  return state;
}

/**
 * Read just the pool_id from a PositionManager's position field.
 * Returns null when no position is open (Option::None).
 */
export async function getPoolIdFromPM(pmId: string): Promise<string | null> {
  const client = getSuiClient();

  const resp = await client.getObject({
    id: pmId,
    options: { showContent: true },
  });

  if (!resp.data || resp.data.content?.dataType !== "moveObject") {
    throw new OnchainFailureError(`PositionManager ${pmId} not found or not a Move object`);
  }

  const fields = (
    resp.data.content as { dataType: "moveObject"; fields: Record<string, unknown> }
  ).fields;

  const positionRaw = fields["position"] as
    | { fields?: { vec?: unknown[] } }
    | null
    | undefined;

  const positionVec = positionRaw?.fields?.["vec"] as unknown[] | undefined ?? [];
  const positionInner = positionVec[0] as
    | { fields?: { pool_id?: unknown } }
    | undefined;

  if (!positionInner?.fields?.pool_id) return null;
  return String(positionInner.fields.pool_id);
}

/**
 * Return true if `agentAddress` appears in the PM's agents VecSet.
 */
export async function isAgentAuthorized(
  pmId: string,
  agentAddress: string,
): Promise<boolean> {
  const client = getSuiClient();

  const resp = await client.getObject({
    id: pmId,
    options: { showContent: true },
  });

  if (!resp.data || resp.data.content?.dataType !== "moveObject") {
    throw new OnchainFailureError(`PositionManager ${pmId} not found or not a Move object`);
  }

  const fields = (
    resp.data.content as { dataType: "moveObject"; fields: Record<string, unknown> }
  ).fields;

  const agentsRaw = fields["agents"] as { fields?: { contents?: unknown[] } } | undefined;
  const contents: string[] = (agentsRaw?.fields?.contents ?? []).map((a) => String(a));
  return contents.includes(agentAddress);
}
