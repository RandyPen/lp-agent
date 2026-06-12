/**
 * Hardcoded Kai SAV mainnet vault metadata.
 *
 * Eliminates runtime dependency on VAULTS / SUPPLY_POOL_STRATEGY_INFOS /
 * getPublishedAt from @kunalabs-io/kai — those imports drag in Aftermath's
 * top-level ESM initialisation which is incompatible with Bun's CJS loader.
 *
 * Sync sources (check on package upgrade — paths relative to `~/Code/kai-ts-sdk`):
 *   src/vault/vault.ts (VAULTS)
 *   src/vault/kai-leverage-supply-pool-strategy.ts (SUPPLY_POOL_STRATEGY_INFOS)
 *   src/lp/supply-pool.ts (SUPPLY_POOL_INFOS)
 *   src/coin-info.ts (yT / klT types)
 *
 * Pattern mirrors cdpm_web/src/lib/lending-config.ts (lines 71–153).
 */

import { normalizeStructTag } from "@mysten/sui/utils";

export type KaiVaultEntry = {
  /** Human label for logging / debugging. */
  symbol: string;
  /** Underlying coin type T. */
  underlyingType: string;
  /** Yield-token type YT. */
  ytType: string;
  /** Shared Vault<T, YT> object id. */
  vaultId: string;
  /** Strategy object id (single per mainnet vault). */
  strategyId: string;
  /** Shared SupplyPool<T, ST> object id used by the strategy. */
  supplyPoolId: string;
  /** SupplyPool's ST (kl* yield-share token) type. */
  stType: string;
};

/**
 * Kai SAV mainnet package constants.
 *
 * PUBLISHED_AT is what PTB `.target` strings must reference.
 * PACKAGE_ID is the original-publish id (rarely needed for tx building).
 *
 * Source: ~/Code/kai-ts-sdk/src/gen/_envs/mainnet.ts:150-152
 */
export const KAI_SAV_MAINNET = {
  PACKAGE_ID:
    "0x1c389a85310b47e7630a9361d4e71025bc35e4999d3a645949b1b68b26f2273",
  PUBLISHED_AT:
    "0x909ad5f8badc34b49507dbd0cb9fb88cc816b531323659e3aefb992d4ab58474",
} as const;

export const KAI_VAULTS: KaiVaultEntry[] = [
  {
    symbol: "USDC",
    underlyingType:
      "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
    ytType:
      "0x7ea359636b36e7c027c2cd71adedaf19be658e1477d9e71368a0b3824a0a27ff::yusdc::YUSDC",
    vaultId:
      "0x3e8a6d1e29d2c86aed50d6055863b878a7dd382de22ea168177c80c1d7150061",
    strategyId:
      "0x4974f5d24f3e23fdeea98ff259446bd086e1e3a0d4aefc0c2f5d0e74919991f1",
    supplyPoolId:
      "0x36162005c3f6ac0875c5b13afe1298d9640234ef305ef8cb2e80cb17cf2bef14",
    stType:
      "0x3f110dd8b324ce4c5df8b344b7d71bdd939083a9ea6f454161667dba872f99d6::klusdc::KLUSDC",
  },
  {
    symbol: "SUI",
    underlyingType: "0x2::sui::SUI",
    ytType:
      "0xb8dc843a816b51992ee10d2ddc6d28aab4f0a1d651cd7289a7897902eb631613::ysui::YSUI",
    vaultId:
      "0x16272b75d880ab944c308d47e91d46b2027f55136ee61b3db99098a926b3973c",
    strategyId:
      "0x81f7d0132e9fd3da7df4cea8d5e75f1792d700c75dfb8602d6ca747db2d2cfee",
    supplyPoolId:
      "0x1b4c4e0869ab3771a0901a538c0dbf536ca72e1525fd66e6c5a197623cd55cc8",
    stType:
      "0x19163b40d52e67e20992f1b74c7376d30616ba966c8174e0990c58074d56eb8d::klsui::KLSUI",
  },
  {
    symbol: "DEEP",
    underlyingType:
      "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP",
    ytType:
      "0x5b2fa5c76309a417ccd14a65f036b8d1ff4e76a143ed878a47fdecfe0b09860e::ydeep::YDEEP",
    vaultId:
      "0x6e58792dccbaa1d1d708d9a847a7c5b3f90c7878d1b76fd79afa48d31063bca6",
    strategyId:
      "0x7315eec88a5a1c0afd42e329822bb28480d405b4aede213fa9973194799327b7",
    supplyPoolId:
      "0x2d001b7f8c8a08f99a4a13fcbaff7feaeac8447741791a2bcd664611cf819ee2",
    stType:
      "0x8fc45d22b3fc276662811e0bada806a3a5f4cb63cd095c418b98df4e8b389f3f::kldeep::KLDEEP",
  },
];

function norm(t: string): string {
  try { return normalizeStructTag(t); } catch { return t.trim(); }
}

export function getKaiVaultByUnderlying(coinType: string): KaiVaultEntry | undefined {
  const key = norm(coinType);
  return KAI_VAULTS.find((v) => norm(v.underlyingType) === key);
}

export function getKaiVaultByYt(ytType: string): KaiVaultEntry | undefined {
  return KAI_VAULTS.find((v) => v.ytType === ytType);
}
