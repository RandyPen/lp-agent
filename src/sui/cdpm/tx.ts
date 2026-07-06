import { Transaction } from "@mysten/sui/transactions";
import { getAgentAddress } from "../keypair.ts";
import { TARGETS, CLOCK_ID, loadCetusIds } from "./package.ts";
import { OnchainFailureError } from "../../lib/errors.ts";
import { loadConfig } from "../../config.ts";
import { appendValidateActiveIdSlippage } from "./txUnified.ts";

// ---- argument interfaces ----

export interface AddLiquidityArgs {
  pmId: string;
  poolId: string;
  coinTypeA: string;
  coinTypeB: string;
  amountA: bigint;
  amountB: bigint;
  bins: number[];
  amountsA: bigint[];
  amountsB: bigint[];
  /**
   * When set (and SLIPPAGE_GUARD_ONCHAIN is on), the PTB opens with the DLMM
   * router's `validate_active_id_slippage` assertion pinned to this bin id ±
   * `slippageMaxBinDrift`.
   */
  plannedActiveBinId?: number;
}

export interface RemoveLiquidityArgs {
  pmId: string;
  poolId: string;
  coinTypeA: string;
  coinTypeB: string;
  bins: number[];
  liquidityShares: bigint[];
}

export interface CollectFeeArgs {
  pmId: string;
  poolId: string;
  coinTypeA: string;
  coinTypeB: string;
}

export interface CollectRewardArgs {
  pmId: string;
  poolId: string;
  coinTypeA: string;
  coinTypeB: string;
  rewardType: string;
}

export interface TransferFeeToBalanceArgs {
  pmId: string;
  coinType: string;
  amount: bigint;
}

// ---- validation helpers ----

function assertNonNegative(value: bigint, label: string): void {
  if (value < 0n) {
    throw new OnchainFailureError(`${label} must be non-negative, got ${value}`);
  }
}

/**
 * Bin IDs are signed I32 on the Move side, sent as their two's-complement u32
 * bit pattern. JS `Number` clamping: `(n | 0) >>> 0` reinterprets a 32-bit
 * signed int as u32.
 */
function binIdToU32Bits(binId: number): number {
  if (!Number.isInteger(binId)) {
    throw new OnchainFailureError(`bin id must be an integer, got ${binId}`);
  }
  return (binId | 0) >>> 0;
}

function assertParallelArrays(
  bins: number[],
  amountsA: bigint[],
  amountsB: bigint[],
): void {
  if (bins.length !== amountsA.length || bins.length !== amountsB.length) {
    throw new OnchainFailureError(
      `bins.length (${bins.length}), amountsA.length (${amountsA.length}), and amountsB.length (${amountsB.length}) must all match`,
    );
  }
}

// ---- tx builders ----

/**
 * Build an agent_add_liquidity PTB.
 * Arg order matches cdpm.move:882-893:
 *   pm, pool, amount_a, amount_b, bins, amounts_a, amounts_b, config, versioned, clk
 */
export function buildAddLiquidityTx(
  args: AddLiquidityArgs,
): { tx: Transaction; description: string } {
  assertParallelArrays(args.bins, args.amountsA, args.amountsB);
  assertNonNegative(args.amountA, "amountA");
  assertNonNegative(args.amountB, "amountB");
  for (let i = 0; i < args.amountsA.length; i++) {
    const a = args.amountsA[i];
    const b = args.amountsB[i];
    if (a === undefined || b === undefined) continue;
    assertNonNegative(a, `amountsA[${i}]`);
    assertNonNegative(b, `amountsB[${i}]`);
  }

  const cfg = loadConfig();
  const { globalConfigId, versionedId } = loadCetusIds(cfg.network);
  const agentAddress = getAgentAddress();

  const tx = new Transaction();
  tx.setSender(agentAddress);

  // On-chain slippage assertion — aborts the PTB when the active bin has
  // drifted beyond cfg.slippageMaxBinDrift from the planned bin.
  if (args.plannedActiveBinId !== undefined && cfg.slippageGuardOnchain) {
    appendValidateActiveIdSlippage(
      tx,
      { poolId: args.poolId, coinTypeA: args.coinTypeA, coinTypeB: args.coinTypeB },
      args.plannedActiveBinId,
      cfg.slippageMaxBinDrift,
      cfg.dlmmPublishedAt,
    );
  }

  tx.moveCall({
    target: TARGETS.agentAddLiquidity,
    typeArguments: [args.coinTypeA, args.coinTypeB],
    arguments: [
      tx.object(args.pmId),
      tx.object(args.poolId),
      tx.pure.u64(args.amountA),
      tx.pure.u64(args.amountB),
      tx.pure.vector("u32", args.bins.map(binIdToU32Bits)),
      tx.pure.vector("u64", args.amountsA),
      tx.pure.vector("u64", args.amountsB),
      tx.object(globalConfigId),
      tx.object(versionedId),
      tx.object(CLOCK_ID),
    ],
  });

  return {
    tx,
    description: `agent_add_liquidity pm=${args.pmId} pool=${args.poolId} bins=[${args.bins.join(",")}] amountA=${args.amountA} amountB=${args.amountB}`,
  };
}

/**
 * Build an agent_remove_liquidity PTB.
 * Arg order matches cdpm.move:925-932:
 *   pm, pool, bins, liquidity_shares, config, versioned, clk
 */
export function buildRemoveLiquidityTx(
  args: RemoveLiquidityArgs,
): { tx: Transaction; description: string } {
  if (args.bins.length !== args.liquidityShares.length) {
    throw new OnchainFailureError(
      `bins.length (${args.bins.length}) and liquidityShares.length (${args.liquidityShares.length}) must match`,
    );
  }
  for (let i = 0; i < args.liquidityShares.length; i++) {
    const share = args.liquidityShares[i];
    if (share === undefined) continue;
    assertNonNegative(share, `liquidityShares[${i}]`);
  }

  const cfg = loadConfig();
  const { globalConfigId, versionedId } = loadCetusIds(cfg.network);
  const agentAddress = getAgentAddress();

  const tx = new Transaction();
  tx.setSender(agentAddress);

  tx.moveCall({
    target: TARGETS.agentRemoveLiquidity,
    typeArguments: [args.coinTypeA, args.coinTypeB],
    arguments: [
      tx.object(args.pmId),
      tx.object(args.poolId),
      tx.pure.vector("u32", args.bins.map(binIdToU32Bits)),
      tx.pure.vector("u128", args.liquidityShares),
      tx.object(globalConfigId),
      tx.object(versionedId),
      tx.object(CLOCK_ID),
    ],
  });

  return {
    tx,
    description: `agent_remove_liquidity pm=${args.pmId} pool=${args.poolId} bins=[${args.bins.join(",")}]`,
  };
}

/**
 * Build an agent_collect_fee PTB.
 * Arg order matches cdpm.move:962-968:
 *   pm, pool, config, versioned
 * Note: no Clock argument — collect_fee doesn't take one.
 */
export function buildCollectFeeTx(
  args: CollectFeeArgs,
): { tx: Transaction; description: string } {
  const cfg = loadConfig();
  const { globalConfigId, versionedId } = loadCetusIds(cfg.network);
  const agentAddress = getAgentAddress();

  const tx = new Transaction();
  tx.setSender(agentAddress);

  tx.moveCall({
    target: TARGETS.agentCollectFee,
    typeArguments: [args.coinTypeA, args.coinTypeB],
    arguments: [
      tx.object(args.pmId),
      tx.object(args.poolId),
      tx.object(globalConfigId),
      tx.object(versionedId),
    ],
  });

  return {
    tx,
    description: `agent_collect_fee pm=${args.pmId} pool=${args.poolId}`,
  };
}

/**
 * Build an agent_collect_reward PTB.
 * Arg order matches cdpm.move:993-998:
 *   pm, pool, config, versioned
 * Type args: [CoinTypeA, CoinTypeB, RewardType]
 */
export function buildCollectRewardTx(
  args: CollectRewardArgs,
): { tx: Transaction; description: string } {
  const cfg = loadConfig();
  const { globalConfigId, versionedId } = loadCetusIds(cfg.network);
  const agentAddress = getAgentAddress();

  const tx = new Transaction();
  tx.setSender(agentAddress);

  tx.moveCall({
    target: TARGETS.agentCollectReward,
    typeArguments: [args.coinTypeA, args.coinTypeB, args.rewardType],
    arguments: [
      tx.object(args.pmId),
      tx.object(args.poolId),
      tx.object(globalConfigId),
      tx.object(versionedId),
    ],
  });

  return {
    tx,
    description: `agent_collect_reward pm=${args.pmId} pool=${args.poolId} rewardType=${args.rewardType}`,
  };
}

/**
 * Build an agent_transfer_fee_to_balance PTB.
 * Arg order matches cdpm.move:1020-1024:
 *   pm, amount
 * Type arg: [T] (the coin type to transfer)
 */
export function buildTransferFeeToBalanceTx(
  args: TransferFeeToBalanceArgs,
): { tx: Transaction; description: string } {
  assertNonNegative(args.amount, "amount");

  const agentAddress = getAgentAddress();

  const tx = new Transaction();
  tx.setSender(agentAddress);

  tx.moveCall({
    target: TARGETS.agentTransferFeeToBalance,
    typeArguments: [args.coinType],
    arguments: [
      tx.object(args.pmId),
      tx.pure.u64(args.amount),
    ],
  });

  return {
    tx,
    description: `agent_transfer_fee_to_balance pm=${args.pmId} coinType=${args.coinType} amount=${args.amount}`,
  };
}
