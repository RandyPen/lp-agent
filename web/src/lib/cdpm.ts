/**
 * CDPM user-side transaction builders + chain reads, trimmed from
 * cdpm_web/src/lib/cdpm-contract.ts to the subset this portal needs:
 * create PM (with liquidity) and authorize the agent.
 *
 * IDs mirror the agent runtime (src/sui/cdpm/package.ts) and the canonical
 * cdpm-agent-sdk constants. The EnrollWizard cross-checks `PACKAGE_ID`
 * against the live agent's /v1/agent/summary before signing — a mismatch
 * means the portal and the agent watch different deployments, and the wizard
 * refuses to proceed.
 */

import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { coinWithBalance, Transaction } from "@mysten/sui/transactions";

export const CDPM = {
  PACKAGE_ID: "0x573584cc4698e82fd85f2b54e64ad4cd901c42b768f7628ec167bf2d24aa2aa7",
  GLOBAL_RECORD_ID: "0xee3b816d68c8d84fe90a2d0ad1861a6fb455d053f8edf6512a8953f7d3e77b95",
  RECORD_TYPE:
    "0x573584cc4698e82fd85f2b54e64ad4cd901c42b768f7628ec167bf2d24aa2aa7::cdpm::Record",
} as const;

export const CETUS = {
  GLOBAL_CONFIG_ID: "0xf31b605d117f959b9730e8c07b08b856cb05143c5e81d5751c90d2979e82f599",
  VERSIONED_ID: "0x05370b2d656612dd5759cbe80463de301e3b94a921dfc72dd9daa2ecdeb2d0a8",
} as const;

export const CLOCK_ID = "0x6";

/** The single pool this portal supports (Cetus DLMM SUI/USDC, mainnet). */
export const POOL = {
  poolId: "0x64e590b0e4d4f7dfc7ae9fae8e9983cd80ad83b658d8499bf550a9d4f6667076",
  label: "SUI / USDC",
  // PHYSICAL pool order is Pool<USDC, SUI>: coinA = USDC(6), coinB = SUI(9).
  coinTypeA: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
  coinTypeB: "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
  symbolA: "USDC",
  symbolB: "SUI",
  decimalsA: 6,
  decimalsB: 9,
  binStep: 50,
  feePercent: 0.4,
} as const;

export interface CreatePositionParams {
  poolId: string;
  coinTypeA: string;
  coinTypeB: string;
  bins: number[];
  amountsA: bigint[];
  amountsB: bigint[];
}

function sumAmounts(amounts: bigint[]): bigint {
  return amounts.reduce((sum, amount) => sum + amount, 0n);
}

function toU32FromI32Bits(value: number): number {
  return Number(BigInt.asUintN(32, BigInt(value)));
}

/** Look up the user's Record object for the current contract via gRPC. */
export async function getUserRecordId(
  client: SuiGrpcClient,
  userAddress: string,
): Promise<string | null> {
  const response = await client.listOwnedObjects({
    owner: userAddress,
    type: CDPM.RECORD_TYPE,
  });
  return response.objects[0]?.objectId ?? null;
}

function appendDepositLiquidity(
  tx: Transaction,
  record: ReturnType<Transaction["object"]> | ReturnType<Transaction["moveCall"]>,
  userAddress: string,
  params: CreatePositionParams,
): void {
  const binIdsU32 = params.bins.map((binId) => toU32FromI32Bits(binId));
  const coinA = tx.add(
    coinWithBalance({ type: params.coinTypeA, balance: sumAmounts(params.amountsA) }),
  );
  const coinB = tx.add(
    coinWithBalance({ type: params.coinTypeB, balance: sumAmounts(params.amountsB) }),
  );

  tx.moveCall({
    target: `${CDPM.PACKAGE_ID}::cdpm::user_deposit_liquidity`,
    typeArguments: [params.coinTypeA, params.coinTypeB],
    arguments: [
      record,
      tx.object(params.poolId),
      coinA,
      coinB,
      tx.pure.vector("u32", binIdsU32),
      tx.pure.vector("u64", params.amountsA.map((a) => a.toString())),
      tx.pure.vector("u64", params.amountsB.map((a) => a.toString())),
      tx.object(CETUS.GLOBAL_CONFIG_ID),
      tx.object(CETUS.VERSIONED_ID),
      tx.object(CLOCK_ID),
    ],
  });

  // user_deposit_liquidity borrows (&mut) the coins — return leftovers.
  tx.transferObjects([coinA, coinB], tx.pure.address(userAddress));
}

/**
 * Build the create-PM transaction (tx1 of the enroll flow). Reuses the
 * caller's Record when one exists; otherwise registers a new Record inside
 * the same PTB. The PositionManager is created and SHARED inside
 * `user_deposit_liquidity` and never escapes as a return value, so agent
 * authorization (`user_insert_agent`) MUST be a second transaction that
 * references the pm_id extracted from this one's PositionManagerCreated
 * event.
 */
export async function buildCreatePositionTx(
  client: SuiGrpcClient,
  userAddress: string,
  params: CreatePositionParams,
): Promise<Transaction> {
  const existingRecordId = await getUserRecordId(client, userAddress);
  const tx = new Transaction();

  if (existingRecordId) {
    appendDepositLiquidity(tx, tx.object(existingRecordId), userAddress, params);
  } else {
    const record = tx.moveCall({
      target: `${CDPM.PACKAGE_ID}::cdpm::register_and_return_record`,
      arguments: [tx.object(CDPM.GLOBAL_RECORD_ID)],
    });
    appendDepositLiquidity(tx, record, userAddress, params);
    tx.moveCall({
      target: `${CDPM.PACKAGE_ID}::cdpm::transfer_record`,
      arguments: [record],
    });
  }

  // coinWithBalance intent resolution requires sender to be known.
  tx.setSenderIfNotSet(userAddress);
  return tx;
}

/** tx2 of the enroll flow: authorize (or revoke) an agent on an existing PM. */
export function buildSetAgentTx(
  userAddress: string,
  params: { pmId: string; agent: string; enabled: boolean },
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${CDPM.PACKAGE_ID}::cdpm::${params.enabled ? "user_insert_agent" : "user_remove_agent"}`,
    arguments: [tx.object(params.pmId), tx.pure.address(params.agent)],
  });
  tx.setSenderIfNotSet(userAddress);
  return tx;
}

// ---------------------------------------------------------------------------
// Chain reads
// ---------------------------------------------------------------------------

export interface PoolSnapshot {
  activeBinId: number;
  binStep: number;
  /** Human price, USDC per SUI. */
  price: number;
}

function parseActiveBinId(raw: unknown): number {
  // active_id is an I32 wrapper: either { bits: number } or a plain number.
  if (typeof raw === "object" && raw !== null && "bits" in raw) {
    const bits = Number((raw as { bits: unknown }).bits);
    return Number(BigInt.asIntN(32, BigInt(bits)));
  }
  return Number(BigInt.asIntN(32, BigInt(Number(raw))));
}

/** Fetch the pool's active bin + derive the human USDC-per-SUI price. */
export async function fetchPoolSnapshot(client: SuiGrpcClient): Promise<PoolSnapshot> {
  const { object } = await client.getObject({
    objectId: POOL.poolId,
    include: { json: true },
  });
  const fields = object?.json as
    | {
        active_id?: unknown;
        bin_manager?: { bin_step?: unknown };
        v_parameters?: { bin_step_config?: { bin_step?: unknown } };
      }
    | undefined;
  if (!fields) throw new Error(`pool object ${POOL.poolId} not found`);

  const activeBinId = parseActiveBinId(fields.active_id);
  const binStep = Number(
    fields.v_parameters?.bin_step_config?.bin_step ?? fields.bin_manager?.bin_step ?? POOL.binStep,
  );

  // DLMM bin price = physical coinB-per-coinA · (1+binStep/1e4)^activeBin with
  // decimal adjustment. Physical order is Pool<USDC, SUI> so the raw price is
  // SUI-per-USDC; the human SUI/USDC pair price is its inverse.
  const rawBPerA =
    Math.pow(1 + binStep / 10_000, activeBinId) *
    Math.pow(10, POOL.decimalsA - POOL.decimalsB);
  const price = 1 / rawBPerA;
  return { activeBinId, binStep, price };
}

const JSONRPC_URL =
  (import.meta.env.VITE_SUI_JSONRPC_URL as string | undefined)?.trim() ||
  "https://fullnode.mainnet.sui.io:443";

/**
 * Extract the pm_id from a creation transaction's PositionManagerCreated
 * event. Called after waitForTransaction; uses JSON-RPC (showEvents) so we
 * don't need a GraphQL layer for one query.
 */
export async function fetchPmIdFromTxEvents(digest: string): Promise<string | null> {
  const res = await fetch(JSONRPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "sui_getTransactionBlock",
      params: [digest, { showEvents: true }],
    }),
  });
  if (!res.ok) throw new Error(`sui_getTransactionBlock: HTTP ${res.status}`);
  const body = (await res.json()) as {
    result?: { events?: Array<{ type?: string; parsedJson?: { pm_id?: string } }> };
    error?: { message: string };
  };
  if (body.error) throw new Error(`sui_getTransactionBlock: ${body.error.message}`);
  for (const ev of body.result?.events ?? []) {
    if (ev.type?.endsWith("::cdpm::PositionManagerCreated") && typeof ev.parsedJson?.pm_id === "string") {
      return ev.parsedJson.pm_id;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Spot bin allocation (trimmed from cdpm_web calculateBinAmounts, spot-only)
// ---------------------------------------------------------------------------

/**
 * Uniform (spot) allocation across `bins`: bins above the active bin hold
 * physical coinA, bins below hold physical coinB, and the active bin (when
 * included) takes a half-weight share of each side — matching the canonical
 * Cetus SDK spot behaviour. Zero-weight bins MUST receive exactly 0 or the
 * on-chain `bin::increase_liquidity` asserts.
 */
export function calculateSpotBinAmounts(
  bins: number[],
  activeBinId: number,
  totalAmountA: bigint,
  totalAmountB: bigint,
): { amountsA: bigint[]; amountsB: bigint[] } {
  const weightsA = bins.map((b) => (b > activeBinId ? 1 : b === activeBinId ? 0.5 : 0));
  const weightsB = bins.map((b) => (b < activeBinId ? 1 : b === activeBinId ? 0.5 : 0));
  return {
    amountsA: splitAmountByWeights(totalAmountA, weightsA),
    amountsB: splitAmountByWeights(totalAmountB, weightsB),
  };
}

function splitAmountByWeights(totalAmount: bigint, weights: number[]): bigint[] {
  if (weights.length === 0) return [];
  if (totalAmount <= 0n) return weights.map(() => 0n);

  const SCALE = 1_000_000;
  const scaled = weights.map((w) =>
    !Number.isFinite(w) || w <= 0 ? 0n : BigInt(Math.max(1, Math.round(w * SCALE))),
  );
  const totalWeight = scaled.reduce((s, w) => s + w, 0n);
  if (totalWeight <= 0n) return weights.map(() => 0n);

  const base: bigint[] = weights.map(() => 0n);
  const remainders: Array<{ index: number; remainder: bigint }> = [];
  let assigned = 0n;
  for (let i = 0; i < scaled.length; i++) {
    const w = scaled[i] ?? 0n;
    if (w === 0n) continue;
    const weighted = totalAmount * w;
    base[i] = weighted / totalWeight;
    assigned += base[i]!;
    remainders.push({ index: i, remainder: weighted % totalWeight });
  }
  let leftover = totalAmount - assigned;
  remainders.sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  );
  for (let i = 0; i < remainders.length && leftover > 0n; i++) {
    base[remainders[i]!.index] = (base[remainders[i]!.index] ?? 0n) + 1n;
    leftover -= 1n;
  }
  return base;
}
