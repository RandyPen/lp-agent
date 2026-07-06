/**
 * Unified rebalance PTB. Emits the canonical command order from the cdpm_web
 * worker reference §9.3 on a single Mysten `Transaction`, so the whole
 * rebalance is atomic and pays a single gas envelope:
 *
 *   [0]  accrue_interest_for_market (when any Scallop op is included)
 *   [1]  agent_collect_fee
 *   [2]  agent_remove_liquidity
 *   [3]  agent_transfer_fee_to_balance (one per side with fees)
 *   [4]  lending redeems  (Scallop start → mint::redeem → finish, repeated;
 *                          then Kai start → strategy walk → finish, repeated)
 *   [5]  agent_add_liquidity
 *   [6]  lending supplies (Scallop start → mint::mint → finish, repeated;
 *                          then Kai start → vault::deposit → finish, repeated)
 *
 * Within the PTB, on-chain code reads `pm.balance` between commands, so
 * post-collect / post-remove / post-redeem amounts are visible to subsequent
 * commands. The agent only needs to (a) decide which commands to include and
 * (b) provide the planned add amounts up front. Amounts are validated by the
 * Move side; any inconsistency aborts the whole PTB.
 *
 * Hot-potato tickets are scoped to the PTB and consumed by `*_finish_*` —
 * they must live inside one tx (Scallop and Kai both lack store/key/drop on
 * the ticket type).
 */

import { Transaction } from "@mysten/sui/transactions";
import { getAgentAddress } from "../keypair.ts";
import { OnchainFailureError } from "../../lib/errors.ts";
import { loadConfig } from "../../config.ts";
import {
  CLOCK_ID,
  SUI_FRAMEWORK,
  TARGETS,
  loadCdpmIds,
  loadCetusIds,
} from "./package.ts";
import { getScallopAdapter } from "../lending/scallop.ts";
import { getKaiAdapter } from "../lending/kai.ts";
import type { LendingDecision } from "../lending/types.ts";
import type { PMState, RebalancePlan } from "../../domain/types.ts";

export interface UnifiedRebalanceInput {
  plan: RebalancePlan;
  /** PM snapshot used for fee-bag amounts and lending entry coin types. */
  pm: PMState;
  /**
   * Lending decisions to fold into the same PTB. Redeems run before
   * `add_liquidity`; supplies run after.
   */
  lendingDecisions: LendingDecision[];
}

type TxInput = Parameters<Transaction["moveCall"]>[0]["arguments"] extends (infer U)[] | undefined
  ? U
  : never;

function assertNonNegative(v: bigint, label: string): void {
  if (v < 0n) throw new OnchainFailureError(`${label} must be non-negative, got ${v}`);
}

/**
 * Bin IDs are signed I32 in the Move side, transmitted as their two's-
 * complement u32 bit pattern (matches `i32ToNumber` in read.ts). Convert a
 * signed JS number to its u32 representation so BCS can serialize it.
 */
function binIdToU32Bits(binId: number): number {
  if (!Number.isInteger(binId)) {
    throw new OnchainFailureError(`bin id must be an integer, got ${binId}`);
  }
  // (binId | 0) clamps to signed 32-bit; >>> 0 reinterprets as u32.
  return (binId | 0) >>> 0;
}

type RedeemDecision = Extract<LendingDecision, { kind: "redeem" }>;
type SupplyDecision = Extract<LendingDecision, { kind: "supply" }>;

function partitionDecisions(decisions: LendingDecision[]): {
  scallopRedeems: RedeemDecision[];
  kaiRedeems: RedeemDecision[];
  scallopSupplies: SupplyDecision[];
  kaiSupplies: SupplyDecision[];
  hasScallop: boolean;
} {
  const scallopRedeems: RedeemDecision[] = [];
  const kaiRedeems: RedeemDecision[] = [];
  const scallopSupplies: SupplyDecision[] = [];
  const kaiSupplies: SupplyDecision[] = [];
  for (const d of decisions) {
    if (d.kind === "redeem") {
      if (d.protocol === "scallop") scallopRedeems.push(d);
      else kaiRedeems.push(d);
    } else if (d.kind === "supply") {
      if (d.protocol === "scallop") scallopSupplies.push(d);
      else kaiSupplies.push(d);
    }
    // noop: ignore
  }
  const hasScallop = scallopRedeems.length > 0 || scallopSupplies.length > 0;
  return { scallopRedeems, kaiRedeems, scallopSupplies, kaiSupplies, hasScallop };
}

function appendScallopAccrueInterest(
  tx: Transaction,
  scallopIds: { protocolPackageId: string; versionId: string; marketId: string },
): void {
  tx.moveCall({
    target: `${scallopIds.protocolPackageId}::accrue_interest::accrue_interest_for_market`,
    arguments: [
      tx.object(scallopIds.versionId),
      tx.object(scallopIds.marketId),
      tx.object(CLOCK_ID),
    ],
  });
}

function appendCollectFee(
  tx: Transaction,
  pm: PMState,
  globalConfigId: string,
  versionedId: string,
): void {
  tx.moveCall({
    target: TARGETS.agentCollectFee,
    typeArguments: [pm.coinTypeA, pm.coinTypeB],
    arguments: [
      tx.object(pm.pmId),
      tx.object(pm.poolId),
      tx.object(globalConfigId),
      tx.object(versionedId),
    ],
  });
}

function appendRemoveLiquidity(
  tx: Transaction,
  pm: PMState,
  bins: number[],
  shares: bigint[],
  globalConfigId: string,
  versionedId: string,
): void {
  for (const s of shares) assertNonNegative(s, "liquidityShare");
  tx.moveCall({
    target: TARGETS.agentRemoveLiquidity,
    typeArguments: [pm.coinTypeA, pm.coinTypeB],
    arguments: [
      tx.object(pm.pmId),
      tx.object(pm.poolId),
      tx.pure.vector("u32", bins.map(binIdToU32Bits)),
      tx.pure.vector("u128", shares),
      tx.object(globalConfigId),
      tx.object(versionedId),
      tx.object(CLOCK_ID),
    ],
  });
}

function appendTransferFeeToBalance(
  tx: Transaction,
  pmId: string,
  coinType: string,
  amount: bigint,
): void {
  assertNonNegative(amount, "transfer_fee amount");
  tx.moveCall({
    target: TARGETS.agentTransferFeeToBalance,
    typeArguments: [coinType],
    arguments: [tx.object(pmId), tx.pure.u64(amount)],
  });
}

/**
 * Append the DLMM router's on-chain active-id slippage assertion:
 *   `<dlmmPublishedAt>::utils::validate_active_id_slippage<A, B>(&Pool<A,B>, u32 activeIdBits, u32 binShift)`
 * Aborts the whole PTB when |pool.active_id − plannedActiveBinId| > maxDriftBins.
 * Signature verified against the mainnet router package (sui_getNormalizedMoveFunction).
 */
export function appendValidateActiveIdSlippage(
  tx: Transaction,
  pm: Pick<PMState, "poolId" | "coinTypeA" | "coinTypeB">,
  plannedActiveBinId: number,
  maxDriftBins: number,
  dlmmPublishedAt: string,
): void {
  if (!Number.isInteger(maxDriftBins) || maxDriftBins < 0) {
    throw new OnchainFailureError(`maxDriftBins must be a non-negative integer, got ${maxDriftBins}`);
  }
  tx.moveCall({
    target: `${dlmmPublishedAt}::utils::validate_active_id_slippage`,
    typeArguments: [pm.coinTypeA, pm.coinTypeB],
    arguments: [
      tx.object(pm.poolId),
      tx.pure.u32(binIdToU32Bits(plannedActiveBinId)),
      tx.pure.u32(maxDriftBins),
    ],
  });
}

function appendAddLiquidity(
  tx: Transaction,
  pm: PMState,
  plan: RebalancePlan,
  globalConfigId: string,
  versionedId: string,
): void {
  assertNonNegative(plan.addAmountA, "addAmountA");
  assertNonNegative(plan.addAmountB, "addAmountB");
  for (let i = 0; i < plan.addAmountsA.length; i++) {
    const a = plan.addAmountsA[i];
    const b = plan.addAmountsB[i];
    if (a !== undefined) assertNonNegative(a, `addAmountsA[${i}]`);
    if (b !== undefined) assertNonNegative(b, `addAmountsB[${i}]`);
  }
  if (plan.addBins.length !== plan.addAmountsA.length || plan.addBins.length !== plan.addAmountsB.length) {
    throw new OnchainFailureError(
      `addLiquidity: bins/amountsA/amountsB length mismatch (${plan.addBins.length}/${plan.addAmountsA.length}/${plan.addAmountsB.length})`,
    );
  }

  tx.moveCall({
    target: TARGETS.agentAddLiquidity,
    typeArguments: [pm.coinTypeA, pm.coinTypeB],
    arguments: [
      tx.object(pm.pmId),
      tx.object(pm.poolId),
      tx.pure.u64(plan.addAmountA),
      tx.pure.u64(plan.addAmountB),
      tx.pure.vector("u32", plan.addBins.map(binIdToU32Bits)),
      tx.pure.vector("u64", plan.addAmountsA),
      tx.pure.vector("u64", plan.addAmountsB),
      tx.object(globalConfigId),
      tx.object(versionedId),
      tx.object(CLOCK_ID),
    ],
  });
}

function appendScallopSupply(
  tx: Transaction,
  pmId: string,
  coinType: string,
  amount: bigint,
  accessListId: string,
  scallopIds: { protocolPackageId: string; versionId: string; marketId: string },
): void {
  assertNonNegative(amount, "scallop supply amount");
  const [coinT, ticket] = tx.moveCall({
    target: TARGETS.scallopStartSupply,
    typeArguments: [coinType],
    arguments: [
      tx.object(accessListId),
      tx.object(pmId),
      tx.object(scallopIds.marketId),
      tx.object(CLOCK_ID),
      tx.pure.u64(amount),
    ],
  });
  const coinMarket = tx.moveCall({
    target: `${scallopIds.protocolPackageId}::mint::mint`,
    typeArguments: [coinType],
    arguments: [
      tx.object(scallopIds.versionId),
      tx.object(scallopIds.marketId),
      coinT!,
      tx.object(CLOCK_ID),
    ],
  });
  tx.moveCall({
    target: TARGETS.scallopFinishSupply,
    typeArguments: [coinType],
    arguments: [
      tx.object(pmId),
      tx.object(scallopIds.marketId),
      ticket!,
      coinMarket,
    ],
  });
}

function appendScallopRedeem(
  tx: Transaction,
  pmId: string,
  coinType: string,
  marketCoinAmount: bigint,
  accessListId: string,
  feeHouseId: string,
  scallopIds: { protocolPackageId: string; versionId: string; marketId: string },
): void {
  assertNonNegative(marketCoinAmount, "scallop redeem amount");
  const [coinMarket, ticket] = tx.moveCall({
    target: TARGETS.scallopStartRedeem,
    typeArguments: [coinType],
    arguments: [
      tx.object(accessListId),
      tx.object(pmId),
      tx.object(scallopIds.marketId),
      tx.object(CLOCK_ID),
      tx.pure.u64(marketCoinAmount),
    ],
  });
  const coinT = tx.moveCall({
    target: `${scallopIds.protocolPackageId}::redeem::redeem`,
    typeArguments: [coinType],
    arguments: [
      tx.object(scallopIds.versionId),
      tx.object(scallopIds.marketId),
      coinMarket!,
      tx.object(CLOCK_ID),
    ],
  });
  tx.moveCall({
    target: TARGETS.scallopFinishRedeem,
    typeArguments: [coinType],
    arguments: [
      tx.object(pmId),
      tx.object(scallopIds.marketId),
      tx.object(feeHouseId),
      ticket!,
      coinT,
    ],
  });
}

function wrapToBalance(tx: Transaction, typeArg: string, coinArg: TxInput) {
  return tx.moveCall({
    target: SUI_FRAMEWORK.coinIntoBalance,
    typeArguments: [typeArg],
    arguments: [coinArg],
  });
}

function wrapToCoin(tx: Transaction, typeArg: string, balanceArg: TxInput) {
  return tx.moveCall({
    target: SUI_FRAMEWORK.coinFromBalance,
    typeArguments: [typeArg],
    arguments: [balanceArg],
  });
}

function appendKaiSupply(
  tx: Transaction,
  pmId: string,
  coinType: string,
  ytType: string,
  amount: bigint,
  accessListId: string,
): void {
  assertNonNegative(amount, "kai supply amount");
  const kai = getKaiAdapter();
  const meta = kai.metaOf(coinType);
  if (!meta) throw new OnchainFailureError(`Kai: no vault for ${coinType}`);
  if (meta.ytType !== ytType) {
    throw new OnchainFailureError(`Kai: ytType mismatch for ${coinType}: arg=${ytType} meta=${meta.ytType}`);
  }
  const savPkg = kai.savPackageId();

  const [coinT, ticket] = tx.moveCall({
    target: TARGETS.kaiStartSupply,
    typeArguments: [coinType, ytType],
    arguments: [
      tx.object(accessListId),
      tx.object(pmId),
      tx.object(meta.vaultId),
      tx.pure.u64(amount),
      tx.object(CLOCK_ID),
    ],
  });
  const balanceT = wrapToBalance(tx, coinType, coinT!);
  const balanceYT = tx.moveCall({
    target: `${savPkg}::vault::deposit`,
    typeArguments: [coinType, ytType],
    arguments: [tx.object(meta.vaultId), balanceT, tx.object(CLOCK_ID)],
  });
  const coinYT = wrapToCoin(tx, ytType, balanceYT);
  tx.moveCall({
    target: TARGETS.kaiFinishSupply,
    typeArguments: [coinType, ytType],
    arguments: [tx.object(pmId), tx.object(meta.vaultId), ticket!, coinYT],
  });
}

function appendKaiRedeem(
  tx: Transaction,
  pmId: string,
  coinType: string,
  ytType: string,
  ytAmount: bigint,
  accessListId: string,
  feeHouseId: string,
): void {
  assertNonNegative(ytAmount, "kai redeem amount");
  const kai = getKaiAdapter();
  const meta = kai.metaOf(coinType);
  if (!meta) throw new OnchainFailureError(`Kai: no vault for ${coinType}`);
  if (meta.ytType !== ytType) {
    throw new OnchainFailureError(`Kai: ytType mismatch for ${coinType}: arg=${ytType} meta=${meta.ytType}`);
  }
  const savPkg = kai.savPackageId();

  const [coinYT, ticket] = tx.moveCall({
    target: TARGETS.kaiStartRedeem,
    typeArguments: [coinType, ytType],
    arguments: [
      tx.object(accessListId),
      tx.object(pmId),
      tx.object(meta.vaultId),
      tx.pure.u64(ytAmount),
      tx.object(CLOCK_ID),
    ],
  });
  const balanceYT = wrapToBalance(tx, ytType, coinYT!);
  const withdrawTicket = tx.moveCall({
    target: `${savPkg}::vault::withdraw`,
    typeArguments: [coinType, ytType],
    arguments: [tx.object(meta.vaultId), balanceYT, tx.object(CLOCK_ID)],
  });
  for (const strat of meta.strategies) {
    tx.moveCall({
      target: `${savPkg}::kai_leverage_supply_pool::withdraw`,
      typeArguments: [strat.tType, strat.stType, strat.ytType],
      arguments: [
        tx.object(strat.id),
        withdrawTicket,
        tx.object(strat.supplyPoolId),
        tx.object(CLOCK_ID),
      ],
    });
  }
  const balanceT = tx.moveCall({
    target: `${savPkg}::vault::redeem_withdraw_ticket`,
    typeArguments: [coinType, ytType],
    arguments: [tx.object(meta.vaultId), withdrawTicket],
  });
  const coinT = wrapToCoin(tx, coinType, balanceT);
  tx.moveCall({
    target: TARGETS.kaiFinishRedeem,
    typeArguments: [coinType, ytType],
    arguments: [
      tx.object(pmId),
      tx.object(meta.vaultId),
      tx.object(feeHouseId),
      ticket!,
      coinT,
    ],
  });
}

/**
 * Build a dryRun-only probe PTB containing just the collect+remove prefix of
 * a plan. Dry-running it yields the `AgentLiquidityRemoved` event with the
 * EXACT amounts the remove would free — the only reliable way to size the
 * re-add, since v0 chain reads leave per-bin position amounts at 0n.
 *
 * Never submit this transaction; it exists for `dryRunTransactionBlock`.
 */
export function buildRemoveProbeTx(
  pm: PMState,
  plan: RebalancePlan,
): { tx: Transaction; commandCount: number } {
  const cfg = loadConfig();
  const { globalConfigId, versionedId } = loadCetusIds(cfg.network);
  const agentAddress = getAgentAddress();

  const tx = new Transaction();
  tx.setSender(agentAddress);
  let commandCount = 0;

  const hasFeesInBag = pm.feeBag.a > 0n || pm.feeBag.b > 0n;
  if (plan.collectFees || hasFeesInBag) {
    appendCollectFee(tx, pm, globalConfigId, versionedId);
    commandCount++;
  }
  if (plan.removeShares.size > 0) {
    const bins: number[] = [];
    const shares: bigint[] = [];
    for (const [binId, share] of plan.removeShares) {
      bins.push(binId);
      shares.push(share);
    }
    appendRemoveLiquidity(tx, pm, bins, shares, globalConfigId, versionedId);
    commandCount++;
  }

  return { tx, commandCount };
}

/**
 * Build the unified rebalance PTB. Returns the Transaction + a human-readable
 * description for the rebalance journal.
 *
 * Empty plan (no remove, no add, no fees, no lending) returns a Transaction
 * with no commands — callers should check `descriptionParts.length > 0`
 * before submitting.
 */
export async function buildUnifiedRebalanceTx(
  input: UnifiedRebalanceInput,
): Promise<{ tx: Transaction; description: string; commandCount: number }> {
  const { plan, pm, lendingDecisions } = input;
  const cfg = loadConfig();
  const { accessListId, feeHouseId } = loadCdpmIds(cfg.network);
  const { globalConfigId, versionedId } = loadCetusIds(cfg.network);
  const agentAddress = getAgentAddress();

  const parts = partitionDecisions(lendingDecisions);
  const needsScallop = parts.hasScallop;
  const scallopIds = needsScallop ? await getScallopAdapter().resolveIds() : null;

  const tx = new Transaction();
  tx.setSender(agentAddress);

  const descriptionParts: string[] = [];
  let commandCount = 0;

  // [0] Scallop accrue_interest_for_market — must be PTB[0] for any Scallop op.
  if (scallopIds) {
    appendScallopAccrueInterest(tx, scallopIds);
    descriptionParts.push("accrue_interest");
    commandCount++;
  }

  // [0.5] On-chain slippage assertion — before any state-changing DLMM op so a
  // drifted active bin aborts the whole PTB. Only relevant when the plan
  // actually adds liquidity (the pre-computed per-bin split is what's priced
  // for the planned active bin). Placed after accrue_interest, which must
  // stay PTB[0] for Scallop ops.
  const willAdd =
    plan.addBins.length > 0 && (plan.addAmountA > 0n || plan.addAmountB > 0n);
  if (willAdd && cfg.slippageGuardOnchain && plan.plannedActiveBinId !== undefined) {
    appendValidateActiveIdSlippage(
      tx,
      pm,
      plan.plannedActiveBinId,
      cfg.slippageMaxBinDrift,
      cfg.dlmmPublishedAt,
    );
    descriptionParts.push(`slippage_guard[±${cfg.slippageMaxBinDrift}]`);
    commandCount++;
  }

  // [1] collect_fee
  const hasFeesInBag = pm.feeBag.a > 0n || pm.feeBag.b > 0n;
  if (plan.collectFees || hasFeesInBag) {
    appendCollectFee(tx, pm, globalConfigId, versionedId);
    descriptionParts.push("collect_fee");
    commandCount++;
  }

  // [2] remove_liquidity
  if (plan.removeShares.size > 0) {
    const bins: number[] = [];
    const shares: bigint[] = [];
    for (const [binId, share] of plan.removeShares) {
      bins.push(binId);
      shares.push(share);
    }
    appendRemoveLiquidity(tx, pm, bins, shares, globalConfigId, versionedId);
    descriptionParts.push(`remove[${bins.length}]`);
    commandCount++;
  }

  // [3] transfer_fee_to_balance (per side with current fee bag amount)
  // After collect_fee runs, the bag has the previously-uncollected fees + any
  // newly collected ones; we drain only the pre-known amount to keep the call
  // deterministic. Any newly-collected fees can be transferred next tick.
  if (pm.feeBag.a > 0n) {
    appendTransferFeeToBalance(tx, pm.pmId, pm.coinTypeA, pm.feeBag.a);
    descriptionParts.push(`transfer_fee[A=${pm.feeBag.a}]`);
    commandCount++;
  }
  if (pm.feeBag.b > 0n) {
    appendTransferFeeToBalance(tx, pm.pmId, pm.coinTypeB, pm.feeBag.b);
    descriptionParts.push(`transfer_fee[B=${pm.feeBag.b}]`);
    commandCount++;
  }

  // [4] lending redeems
  for (const d of parts.scallopRedeems) {
    if (!scallopIds) throw new OnchainFailureError("scallopIds missing for Scallop redeem");
    appendScallopRedeem(
      tx,
      d.pmId,
      d.coinType,
      d.marketCoinAmount,
      accessListId,
      feeHouseId,
      scallopIds,
    );
    descriptionParts.push(`scallop_redeem[${d.marketCoinAmount}]`);
    commandCount++;
  }
  for (const d of parts.kaiRedeems) {
    appendKaiRedeem(
      tx,
      d.pmId,
      d.coinType,
      d.ytType,
      d.marketCoinAmount,
      accessListId,
      feeHouseId,
    );
    descriptionParts.push(`kai_redeem[${d.marketCoinAmount}]`);
    commandCount++;
  }

  // [5] add_liquidity
  if (plan.addBins.length > 0 && (plan.addAmountA > 0n || plan.addAmountB > 0n)) {
    appendAddLiquidity(tx, pm, plan, globalConfigId, versionedId);
    descriptionParts.push(`add[${plan.addBins.length}]`);
    commandCount++;
  }

  // [6] lending supplies
  for (const d of parts.scallopSupplies) {
    if (!scallopIds) throw new OnchainFailureError("scallopIds missing for Scallop supply");
    appendScallopSupply(tx, d.pmId, d.coinType, d.amount, accessListId, scallopIds);
    descriptionParts.push(`scallop_supply[${d.amount}]`);
    commandCount++;
  }
  for (const d of parts.kaiSupplies) {
    appendKaiSupply(tx, d.pmId, d.coinType, d.ytType, d.amount, accessListId);
    descriptionParts.push(`kai_supply[${d.amount}]`);
    commandCount++;
  }

  return {
    tx,
    description: `unified[${commandCount}]: ${descriptionParts.join(" → ")}`,
    commandCount,
  };
}
