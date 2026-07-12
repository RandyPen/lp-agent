/**
 * probe-bin-orientation.ts — empirically verify DLMM bin↔coin orientation
 * on the live mainnet SUI/USDC pool.
 *
 * Question being settled (Phase 0 of the wiring-fix plan):
 *   For Pool<CoinA, CoinB>, which physical coin do bins ABOVE the active bin
 *   hold, and which do bins BELOW hold?
 *
 * Hypothesis (from @cetusprotocol/dlmm-sdk `toAmountAskSide(amount_a)` /
 * `toAmountBidSide(amount_b)` and the operator's rule "bid区域=quote coin,
 * ask区域=base coin"):
 *   binId > active → physical coinA only
 *   binId < active → physical coinB only
 *   binId = active → both (composition-fee territory)
 *
 * For the SUI/USDC pool the physical order is Pool<USDC, SUI>, so the
 * hypothesis predicts: above-active bins hold USDC, below-active bins hold SUI.
 *
 * READ-ONLY: raw JSON-RPC only — no keys, no transactions, no SDK.
 *
 * Usage: bun run scripts/probe-bin-orientation.ts [poolId]
 *   poolId defaults to SUI_USDC_POOL_ID env, else auto-discovers the
 *   highest-TVL SUI/USDC DLMM pool via the Cetus stats API.
 */

const FULLNODE = process.env.SUI_RPC_URL ?? "https://fullnode.mainnet.sui.io:443";
const STATS_URL = "https://api-sui.cetus.zone/v3/sui/dlmm/stats_pools";
const SUI_LONG =
  "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const USDC_NATIVE =
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";

// ---- tiny JSON-RPC helper --------------------------------------------------

let rpcId = 0;
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const resp = await fetch(FULLNODE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  if (!resp.ok) throw new Error(`${method} HTTP ${resp.status}`);
  const json = (await resp.json()) as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  if (json.result === undefined) throw new Error(`${method}: empty result`);
  return json.result;
}

function decodeI32(bits: number): number {
  const u = bits >>> 0;
  return u & 0x8000_0000 ? u - 0x1_0000_0000 : u;
}

function extractBits(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number(v);
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    if ("bits" in o) return Number(o["bits"]);
    if ("fields" in o) return extractBits(o["fields"]);
  }
  return null;
}

// ---- pool discovery ----------------------------------------------------------

function normalizeCoinType(t: string): string {
  const [addr, ...rest] = t.split("::");
  if (!addr || !addr.startsWith("0x")) return t.toLowerCase();
  return ["0x" + addr.slice(2).padStart(64, "0"), ...rest].join("::").toLowerCase();
}

async function discoverPool(): Promise<string> {
  const want = new Set([normalizeCoinType(SUI_LONG), normalizeCoinType(USDC_NATIVE)]);
  const resp = await fetch(STATS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ limit: 100, offset: 0 }),
  });
  if (!resp.ok) throw new Error(`stats_pools HTTP ${resp.status}`);
  const json = (await resp.json()) as {
    code: number;
    data: {
      list: Array<{
        pool: string;
        tvl: string;
        coinA: { coinType: string };
        coinB: { coinType: string };
      }>;
    };
  };
  if (json.code !== 0) throw new Error("stats_pools api error");
  const matches = json.data.list.filter((p) => {
    const a = normalizeCoinType(p.coinA.coinType);
    const b = normalizeCoinType(p.coinB.coinType);
    return want.has(a) && want.has(b) && a !== b;
  });
  if (matches.length === 0) throw new Error("no SUI/USDC DLMM pool in stats list");
  matches.sort((x, y) => Number(y.tvl) - Number(x.tvl));
  return matches[0]!.pool;
}

// ---- bin extraction ----------------------------------------------------------

interface BinObs {
  binId: number;
  amountA: bigint;
  amountB: bigint;
}

/**
 * Recursively hunt for Bin-shaped objects ({ id:{bits}, amount_a, amount_b })
 * anywhere inside a dynamic-field node's JSON. Tolerant of the SkipList
 * node/BinGroupRef wrapper shapes.
 */
function collectBins(node: unknown, out: BinObs[]): void {
  if (typeof node !== "object" || node === null) return;
  if (Array.isArray(node)) {
    for (const item of node) collectBins(item, out);
    return;
  }
  const o = node as Record<string, unknown>;
  if ("amount_a" in o && "amount_b" in o && "id" in o) {
    const bits = extractBits(o["id"]);
    if (bits !== null) {
      out.push({
        binId: decodeI32(bits),
        amountA: BigInt(o["amount_a"] as string | number),
        amountB: BigInt(o["amount_b"] as string | number),
      });
      return;
    }
  }
  for (const v of Object.values(o)) collectBins(v, out);
}

// ---- main --------------------------------------------------------------------

const poolId = process.argv[2] ?? process.env.SUI_USDC_POOL_ID ?? (await discoverPool());
console.log(`pool: ${poolId}`);

interface ObjResp {
  data?: { type?: string; content?: { fields?: Record<string, unknown> } };
}
const poolObj = await rpc<ObjResp>("sui_getObject", [
  poolId,
  { showContent: true, showType: true },
]);
const poolType = poolObj.data?.type ?? "";
const poolFields = poolObj.data?.content?.fields ?? {};
console.log(`type: ${poolType}`);

// Physical coin order from the type args.
const typeArgs = poolType.match(/<(.+)>/)?.[1]?.split(/,\s*/) ?? [];
const physA = typeArgs[0] ?? "?";
const physB = typeArgs[1] ?? "?";
console.log(`physical coinA: ${physA}`);
console.log(`physical coinB: ${physB}`);

const activeBits = extractBits(poolFields["active_id"]);
if (activeBits === null) throw new Error("cannot extract active_id");
const activeBin = decodeI32(activeBits);
console.log(`active bin: ${activeBin} (bits=${activeBits >>> 0})`);

// bin_manager → bins (SkipList) inner object id
const binManager = poolFields["bin_manager"] as
  | { fields?: Record<string, unknown> }
  | undefined;
const bins = binManager?.fields?.["bins"] as
  | { fields?: Record<string, unknown> }
  | undefined;
// SkipList surfaces its dynamic-field parent as fields.id.id
const skipListId = (bins?.fields?.["id"] as { id?: string } | undefined)?.id;
if (!skipListId) {
  console.log("bin_manager keys:", Object.keys(binManager?.fields ?? {}));
  console.log("bins keys:", Object.keys(bins?.fields ?? {}));
  throw new Error("cannot locate SkipList object id under bin_manager.bins");
}
console.log(`skip list id: ${skipListId}`);

// Enumerate dynamic fields (skip-list nodes). Each node holds one BinGroup(16 bins).
interface DynField {
  objectId: string;
  name: { value?: unknown };
}
const fieldIds: { objectId: string; score: number }[] = [];
let cursor: string | null = null as string | null;
for (;;) {
  const page = await rpc<{ data: DynField[]; hasNextPage: boolean; nextCursor: string | null }>(
    "suix_getDynamicFields",
    [skipListId, cursor, 50],
  );
  for (const f of page.data) {
    fieldIds.push({ objectId: f.objectId, score: Number(f.name.value ?? NaN) });
  }
  if (!page.hasNextPage) break;
  cursor = page.nextCursor;
}
console.log(`skip-list nodes (bin groups): ${fieldIds.length}`);

// The skip-list score encoding isn't a simple bits>>4 — just fetch every node
// (small count) and filter by decoded bin id afterwards.
const observed: BinObs[] = [];
for (let i = 0; i < fieldIds.length; i += 50) {
  const chunk = fieldIds.slice(i, i + 50);
  const nodeObjs = await rpc<ObjResp[]>("sui_multiGetObjects", [
    chunk.map((n) => n.objectId),
    { showContent: true },
  ]);
  for (const obj of nodeObjs) {
    collectBins(obj.data?.content?.fields ?? {}, observed);
  }
}
observed.sort((a, b) => a.binId - b.binId);
console.log(`bins decoded: ${observed.length}`);

// ---- verdict -------------------------------------------------------------------

console.log(`\n bin      Δactive   amount_a           amount_b`);
let aboveOnlyA = 0;
let aboveOnlyB = 0;
let belowOnlyA = 0;
let belowOnlyB = 0;
let mixedAbove = 0;
let mixedBelow = 0;
for (const b of observed) {
  if (b.amountA === 0n && b.amountB === 0n) continue;
  const delta = b.binId - activeBin;
  const marker = delta === 0 ? "← ACTIVE" : "";
  // Print only a window near active to keep output readable; stats cover all bins.
  if (Math.abs(delta) <= 30) {
    console.log(
      ` ${String(b.binId).padEnd(8)} ${String(delta).padStart(7)}   ${b.amountA
        .toString()
        .padEnd(18)} ${b.amountB.toString().padEnd(18)} ${marker}`,
    );
  }
  if (delta > 0) {
    if (b.amountA > 0n && b.amountB === 0n) aboveOnlyA++;
    else if (b.amountB > 0n && b.amountA === 0n) aboveOnlyB++;
    else mixedAbove++;
  } else if (delta < 0) {
    if (b.amountA > 0n && b.amountB === 0n) belowOnlyA++;
    else if (b.amountB > 0n && b.amountA === 0n) belowOnlyB++;
    else mixedBelow++;
  }
}

console.log(`\nabove active: onlyA=${aboveOnlyA} onlyB=${aboveOnlyB} mixed=${mixedAbove}`);
console.log(`below active: onlyA=${belowOnlyA} onlyB=${belowOnlyB} mixed=${mixedBelow}`);

const hypothesisHolds =
  aboveOnlyA > 0 && aboveOnlyB === 0 && mixedAbove === 0 &&
  belowOnlyB > 0 && belowOnlyA === 0 && mixedBelow === 0;
const inverseHolds =
  aboveOnlyB > 0 && aboveOnlyA === 0 && mixedAbove === 0 &&
  belowOnlyA > 0 && belowOnlyB === 0 && mixedBelow === 0;

if (hypothesisHolds) {
  console.log(
    "\nVERDICT: CONFIRMED — bins above active hold physical coinA only, " +
      "below hold physical coinB only.\n" +
      "→ The repo's current side-split (below←balance.a, above←balance.b) is INVERTED.",
  );
} else if (inverseHolds) {
  console.log(
    "\nVERDICT: REFUTED — bins above active hold physical coinB, below hold coinA.\n" +
      "→ The repo's current side-split matches the chain; do NOT flip.",
  );
} else {
  console.log(
    "\nVERDICT: INCONCLUSIVE — mixed or empty samples; inspect the table above.",
  );
}
