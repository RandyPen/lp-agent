import { ConfigError } from "../../lib/errors.ts";

// Current CDPM deployment — see ~/Code/cdpm/skills/cdpm-agent-sdk/reference/constants.md
export const CDPM_PACKAGE = "0x573584cc4698e82fd85f2b54e64ad4cd901c42b768f7628ec167bf2d24aa2aa7";
export const CDPM_MODULE = "cdpm";

/** Shared CDPM mainnet objects required by lending PTBs. */
export const CDPM_MAINNET = {
  feeHouseId: "0x44cc921bdabdd4d868b32ba7081b71707b685eecc6b6034668281088bea0b5d8",
  accessListId: "0xdca06884b21a23d04f2664835c0c965dc80a5c40294b90d9d000c7b05707f803",
  adminCapId: "0x91940a5f725a9359d9778501fb6b9e2eff45e629127d612e8ce9d0cdc1102463",
  globalRecordId: "0xee3b816d68c8d84fe90a2d0ad1861a6fb455d053f8edf6512a8953f7d3e77b95",
} as const;

export interface CdpmIds {
  feeHouseId: string;
  accessListId: string;
}

export function loadCdpmIds(network: "mainnet" | "testnet" | "devnet"): CdpmIds {
  if (network === "mainnet") return CDPM_MAINNET;
  const feeHouseId = process.env.CDPM_FEE_HOUSE_ID ?? "";
  const accessListId = process.env.CDPM_ACCESS_LIST_ID ?? "";
  if (!feeHouseId || !accessListId) {
    throw new ConfigError(
      `${network}: set CDPM_FEE_HOUSE_ID and CDPM_ACCESS_LIST_ID env vars`,
    );
  }
  return { feeHouseId, accessListId };
}

/**
 * Cetus DLMM shared objects required by every agent_* moveCall.
 * Mainnet ids verified against the cdpm-agent-sdk constants reference.
 * Testnet/devnet ids must be supplied via env when running on those networks.
 */
export interface CetusDlmmIds {
  globalConfigId: string;
  versionedId: string;
}

export const CETUS_MAINNET: CetusDlmmIds = {
  globalConfigId: "0xf31b605d117f959b9730e8c07b08b856cb05143c5e81d5751c90d2979e82f599",
  versionedId: "0x05370b2d656612dd5759cbe80463de301e3b94a921dfc72dd9daa2ecdeb2d0a8",
};

export const CLOCK_ID = "0x6";

export function loadCetusIds(network: "mainnet" | "testnet" | "devnet"): CetusDlmmIds {
  if (network === "mainnet") return CETUS_MAINNET;
  const globalConfigId = process.env.CETUS_GLOBAL_CONFIG_ID ?? "";
  const versionedId = process.env.CETUS_VERSIONED_ID ?? "";
  if (!globalConfigId || !versionedId) {
    throw new ConfigError(
      `${network}: set CETUS_GLOBAL_CONFIG_ID and CETUS_VERSIONED_ID env vars`,
    );
  }
  return { globalConfigId, versionedId };
}

/** Fully-qualified Move targets for the agent_* entrypoints. */
export const TARGETS = {
  // Original DLMM ops
  agentAddLiquidity: `${CDPM_PACKAGE}::${CDPM_MODULE}::agent_add_liquidity`,
  agentRemoveLiquidity: `${CDPM_PACKAGE}::${CDPM_MODULE}::agent_remove_liquidity`,
  agentCollectFee: `${CDPM_PACKAGE}::${CDPM_MODULE}::agent_collect_fee`,
  agentCollectReward: `${CDPM_PACKAGE}::${CDPM_MODULE}::agent_collect_reward`,
  agentTransferFeeToBalance: `${CDPM_PACKAGE}::${CDPM_MODULE}::agent_transfer_fee_to_balance`,
  // Scallop lending hot-potato
  scallopStartSupply: `${CDPM_PACKAGE}::${CDPM_MODULE}::scallop_start_supply`,
  scallopFinishSupply: `${CDPM_PACKAGE}::${CDPM_MODULE}::scallop_finish_supply`,
  scallopStartRedeem: `${CDPM_PACKAGE}::${CDPM_MODULE}::scallop_start_redeem`,
  scallopFinishRedeem: `${CDPM_PACKAGE}::${CDPM_MODULE}::scallop_finish_redeem`,
  // Kai SAV lending hot-potato
  kaiStartSupply: `${CDPM_PACKAGE}::${CDPM_MODULE}::kai_start_supply`,
  kaiFinishSupply: `${CDPM_PACKAGE}::${CDPM_MODULE}::kai_finish_supply`,
  kaiStartRedeem: `${CDPM_PACKAGE}::${CDPM_MODULE}::kai_start_redeem`,
  kaiFinishRedeem: `${CDPM_PACKAGE}::${CDPM_MODULE}::kai_finish_redeem`,
} as const;

/** Sui framework helpers used to bridge Coin <-> Balance in lending PTBs. */
export const SUI_FRAMEWORK = {
  coinIntoBalance: "0x2::coin::into_balance",
  coinFromBalance: "0x2::coin::from_balance",
} as const;

/** Fully-qualified Move event types we subscribe to. */
export const EVENT_TYPES = {
  PositionManagerCreated: `${CDPM_PACKAGE}::${CDPM_MODULE}::PositionManagerCreated`,
  PositionManagerClosed: `${CDPM_PACKAGE}::${CDPM_MODULE}::PositionManagerClosed`,
  AgentAdded: `${CDPM_PACKAGE}::${CDPM_MODULE}::AgentAdded`,
  AgentRemoved: `${CDPM_PACKAGE}::${CDPM_MODULE}::AgentRemoved`,
  AgentLiquidityAdded: `${CDPM_PACKAGE}::${CDPM_MODULE}::AgentLiquidityAdded`,
  AgentLiquidityRemoved: `${CDPM_PACKAGE}::${CDPM_MODULE}::AgentLiquidityRemoved`,
  AgentFeeCollected: `${CDPM_PACKAGE}::${CDPM_MODULE}::AgentFeeCollected`,
  AgentRewardCollected: `${CDPM_PACKAGE}::${CDPM_MODULE}::AgentRewardCollected`,
  ScallopSupplied: `${CDPM_PACKAGE}::${CDPM_MODULE}::ScallopSupplied`,
  ScallopRedeemed: `${CDPM_PACKAGE}::${CDPM_MODULE}::ScallopRedeemed`,
  KaiSupplied: `${CDPM_PACKAGE}::${CDPM_MODULE}::KaiSupplied`,
  KaiRedeemed: `${CDPM_PACKAGE}::${CDPM_MODULE}::KaiRedeemed`,
} as const;
