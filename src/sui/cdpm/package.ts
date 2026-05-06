import { ConfigError } from "../../lib/errors.ts";

export const CDPM_PACKAGE = "0xbb15c25329fbc85b9cc9cc1d37ee2f913696a7c688d0552ca4dc7e3557598541";
export const CDPM_MODULE = "cdpm";

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
  agentAddLiquidity: `${CDPM_PACKAGE}::${CDPM_MODULE}::agent_add_liquidity`,
  agentRemoveLiquidity: `${CDPM_PACKAGE}::${CDPM_MODULE}::agent_remove_liquidity`,
  agentCollectFee: `${CDPM_PACKAGE}::${CDPM_MODULE}::agent_collect_fee`,
  agentCollectReward: `${CDPM_PACKAGE}::${CDPM_MODULE}::agent_collect_reward`,
  agentTransferFeeToBalance: `${CDPM_PACKAGE}::${CDPM_MODULE}::agent_transfer_fee_to_balance`,
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
} as const;
