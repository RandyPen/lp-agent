import { Transaction } from "@mysten/sui/transactions";
import { getAgentAddress } from "../keypair.ts";
import { OnchainFailureError } from "../../lib/errors.ts";
import { loadConfig } from "../../config.ts";
import { CLOCK_ID, SUI_FRAMEWORK, TARGETS, loadCdpmIds } from "./package.ts";
import { getScallopAdapter } from "../lending/scallop.ts";
import { getKaiAdapter } from "../lending/kai.ts";

/**
 * Hot-potato PTB composers for the lending leg. Each call returns a single
 * Transaction ready to sign — start/finish must live in the same PTB because
 * the ticket types do not have `key`/`store` and would abort if dangled.
 *
 * Scallop PTBs MUST start with `accrue_interest::accrue_interest_for_market`
 * as command 0; CDPM enforces this on-chain (EStaleScallopState = 1011).
 * See ~/Code/cdpm/skills/cdpm-agent-sdk/reference/scallop-lending.md.
 */

export interface ScallopSupplyArgs {
  pmId: string;
  coinType: string;
  /** Underlying amount to supply, in base units. Use MAX_U64 (`2n**64n − 1n`) to drain. */
  amount: bigint;
}

export interface ScallopRedeemArgs {
  pmId: string;
  coinType: string;
  /** sCoin (MarketCoin<T>) amount to burn, in base units. */
  marketCoinAmount: bigint;
}

export interface KaiSupplyArgs {
  pmId: string;
  coinType: string;
  ytType: string;
  amount: bigint;
}

export interface KaiRedeemArgs {
  pmId: string;
  coinType: string;
  ytType: string;
  ytAmount: bigint;
}

function assertPositive(value: bigint, label: string): void {
  if (value <= 0n) {
    throw new OnchainFailureError(`${label} must be > 0, got ${value}`);
  }
}

// ---- Scallop ----

export async function buildScallopSupplyTx(
  args: ScallopSupplyArgs,
): Promise<{ tx: Transaction; description: string }> {
  assertPositive(args.amount, "amount");
  const cfg = loadConfig();
  const { accessListId } = loadCdpmIds(cfg.network);
  const ids = await getScallopAdapter().resolveIds();
  const agentAddress = getAgentAddress();

  const tx = new Transaction();
  tx.setSender(agentAddress);

  // [0] accrue_interest_for_market — MANDATORY.
  tx.moveCall({
    target: `${ids.protocolPackageId}::accrue_interest::accrue_interest_for_market`,
    arguments: [tx.object(ids.versionId), tx.object(ids.marketId), tx.object(CLOCK_ID)],
  });

  // [1] cdpm::scallop_start_supply<T>(access, pm, market, clock, amount) -> (coin_t, ticket)
  const [coinT, ticket] = tx.moveCall({
    target: TARGETS.scallopStartSupply,
    typeArguments: [args.coinType],
    arguments: [
      tx.object(accessListId),
      tx.object(args.pmId),
      tx.object(ids.marketId),
      tx.object(CLOCK_ID),
      tx.pure.u64(args.amount),
    ],
  });

  // [2] protocol::mint::mint<T>(version, market, coin_t, clock) -> coin_market
  const coinMarket = tx.moveCall({
    target: `${ids.protocolPackageId}::mint::mint`,
    typeArguments: [args.coinType],
    arguments: [tx.object(ids.versionId), tx.object(ids.marketId), coinT!, tx.object(CLOCK_ID)],
  });

  // [3] cdpm::scallop_finish_supply<T>(pm, market, ticket, coin_market)
  tx.moveCall({
    target: TARGETS.scallopFinishSupply,
    typeArguments: [args.coinType],
    arguments: [tx.object(args.pmId), tx.object(ids.marketId), ticket!, coinMarket],
  });

  return {
    tx,
    description: `scallop_supply pm=${args.pmId} coin=${args.coinType} amount=${args.amount}`,
  };
}

export async function buildScallopRedeemTx(
  args: ScallopRedeemArgs,
): Promise<{ tx: Transaction; description: string }> {
  assertPositive(args.marketCoinAmount, "marketCoinAmount");
  const cfg = loadConfig();
  const { accessListId, feeHouseId } = loadCdpmIds(cfg.network);
  const ids = await getScallopAdapter().resolveIds();
  const agentAddress = getAgentAddress();

  const tx = new Transaction();
  tx.setSender(agentAddress);

  // [0] accrue_interest_for_market — MANDATORY.
  tx.moveCall({
    target: `${ids.protocolPackageId}::accrue_interest::accrue_interest_for_market`,
    arguments: [tx.object(ids.versionId), tx.object(ids.marketId), tx.object(CLOCK_ID)],
  });

  // [1] cdpm::scallop_start_redeem<T>(access, pm, market, clock, sCoinAmount) -> (coin_market, ticket)
  const [coinMarket, ticket] = tx.moveCall({
    target: TARGETS.scallopStartRedeem,
    typeArguments: [args.coinType],
    arguments: [
      tx.object(accessListId),
      tx.object(args.pmId),
      tx.object(ids.marketId),
      tx.object(CLOCK_ID),
      tx.pure.u64(args.marketCoinAmount),
    ],
  });

  // [2] protocol::redeem::redeem<T>(version, market, coin_market, clock) -> coin_t
  const coinT = tx.moveCall({
    target: `${ids.protocolPackageId}::redeem::redeem`,
    typeArguments: [args.coinType],
    arguments: [tx.object(ids.versionId), tx.object(ids.marketId), coinMarket!, tx.object(CLOCK_ID)],
  });

  // [3] cdpm::scallop_finish_redeem<T>(pm, market, fee_house, ticket, coin_t)
  tx.moveCall({
    target: TARGETS.scallopFinishRedeem,
    typeArguments: [args.coinType],
    arguments: [
      tx.object(args.pmId),
      tx.object(ids.marketId),
      tx.object(feeHouseId),
      ticket!,
      coinT,
    ],
  });

  return {
    tx,
    description: `scallop_redeem pm=${args.pmId} coin=${args.coinType} sCoin=${args.marketCoinAmount}`,
  };
}

// ---- Kai SAV ----

export function buildKaiSupplyTx(args: KaiSupplyArgs): { tx: Transaction; description: string } {
  assertPositive(args.amount, "amount");
  const cfg = loadConfig();
  const { accessListId } = loadCdpmIds(cfg.network);
  const kai = getKaiAdapter();
  const meta = kai.metaOf(args.coinType);
  if (!meta) {
    throw new OnchainFailureError(`Kai: no vault for coin type ${args.coinType}`);
  }
  if (meta.ytType !== args.ytType) {
    throw new OnchainFailureError(
      `Kai: ytType mismatch for ${args.coinType}: arg=${args.ytType} meta=${meta.ytType}`,
    );
  }
  const savPkg = kai.savPackageId();
  const agentAddress = getAgentAddress();

  const tx = new Transaction();
  tx.setSender(agentAddress);

  // [0] cdpm::kai_start_supply<T, YT>(access, pm, vault, amount, clock) -> (coin_t, ticket)
  const [coinT, ticket] = tx.moveCall({
    target: TARGETS.kaiStartSupply,
    typeArguments: [args.coinType, args.ytType],
    arguments: [
      tx.object(accessListId),
      tx.object(args.pmId),
      tx.object(meta.vaultId),
      tx.pure.u64(args.amount),
      tx.object(CLOCK_ID),
    ],
  });

  // [1] coin::into_balance<T>(coin_t) -> balance_t
  const balanceT = wrapToBalance(tx, args.coinType, coinT!);

  // [2] kai_sav::vault::deposit<T, YT>(vault, balance_t, clock) -> balance_yt
  const balanceYT = tx.moveCall({
    target: `${savPkg}::vault::deposit`,
    typeArguments: [args.coinType, args.ytType],
    arguments: [tx.object(meta.vaultId), balanceT, tx.object(CLOCK_ID)],
  });

  // [3] coin::from_balance<YT>(balance_yt) -> coin_yt
  const coinYT = wrapToCoin(tx, args.ytType, balanceYT);

  // [4] cdpm::kai_finish_supply<T, YT>(pm, vault, ticket, coin_yt)
  tx.moveCall({
    target: TARGETS.kaiFinishSupply,
    typeArguments: [args.coinType, args.ytType],
    arguments: [tx.object(args.pmId), tx.object(meta.vaultId), ticket!, coinYT],
  });

  return {
    tx,
    description: `kai_supply pm=${args.pmId} coin=${args.coinType} amount=${args.amount}`,
  };
}

export function buildKaiRedeemTx(args: KaiRedeemArgs): { tx: Transaction; description: string } {
  assertPositive(args.ytAmount, "ytAmount");
  const cfg = loadConfig();
  const { accessListId, feeHouseId } = loadCdpmIds(cfg.network);
  const kai = getKaiAdapter();
  const meta = kai.metaOf(args.coinType);
  if (!meta) {
    throw new OnchainFailureError(`Kai: no vault for coin type ${args.coinType}`);
  }
  if (meta.ytType !== args.ytType) {
    throw new OnchainFailureError(
      `Kai: ytType mismatch for ${args.coinType}: arg=${args.ytType} meta=${meta.ytType}`,
    );
  }
  const savPkg = kai.savPackageId();
  const agentAddress = getAgentAddress();

  const tx = new Transaction();
  tx.setSender(agentAddress);

  // [0] cdpm::kai_start_redeem<T, YT>(access, pm, vault, ytAmount, clock) -> (coin_yt, ticket)
  const [coinYT, ticket] = tx.moveCall({
    target: TARGETS.kaiStartRedeem,
    typeArguments: [args.coinType, args.ytType],
    arguments: [
      tx.object(accessListId),
      tx.object(args.pmId),
      tx.object(meta.vaultId),
      tx.pure.u64(args.ytAmount),
      tx.object(CLOCK_ID),
    ],
  });

  // [1] coin::into_balance<YT>(coin_yt) -> balance_yt
  const balanceYT = wrapToBalance(tx, args.ytType, coinYT!);

  // [2] kai_sav::vault::withdraw<T, YT>(vault, balance_yt, clock) -> withdraw_ticket
  const withdrawTicket = tx.moveCall({
    target: `${savPkg}::vault::withdraw`,
    typeArguments: [args.coinType, args.ytType],
    arguments: [tx.object(meta.vaultId), balanceYT, tx.object(CLOCK_ID)],
  });

  // [3..3+N] Strategy walk: each `kai_leverage_supply_pool::withdraw<T, ST, YT>`
  // call discharges one strategy slot inside the ticket.
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

  // [+N+1] kai_sav::vault::redeem_withdraw_ticket<T, YT>(vault, ticket) -> balance_t
  const balanceT = tx.moveCall({
    target: `${savPkg}::vault::redeem_withdraw_ticket`,
    typeArguments: [args.coinType, args.ytType],
    arguments: [tx.object(meta.vaultId), withdrawTicket],
  });

  // [+N+2] coin::from_balance<T>(balance_t) -> coin_t
  const coinT = wrapToCoin(tx, args.coinType, balanceT);

  // [+N+3] cdpm::kai_finish_redeem<T, YT>(pm, vault, fee_house, ticket, coin_t)
  tx.moveCall({
    target: TARGETS.kaiFinishRedeem,
    typeArguments: [args.coinType, args.ytType],
    arguments: [
      tx.object(args.pmId),
      tx.object(meta.vaultId),
      tx.object(feeHouseId),
      ticket!,
      coinT,
    ],
  });

  return {
    tx,
    description: `kai_redeem pm=${args.pmId} coin=${args.coinType} yt=${args.ytAmount} strategies=${meta.strategies.length}`,
  };
}

// ---- helpers ----

/**
 * Element type accepted by `tx.moveCall({ arguments: [...] })`. Includes
 * `TransactionArgument` for raw inputs and `TransactionResult` /
 * `NestedResult` for handles produced by prior commands.
 */
type TxInput = Parameters<Transaction["moveCall"]>[0]["arguments"] extends (infer U)[] | undefined
  ? U
  : never;

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
