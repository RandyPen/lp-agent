import { getVaultDataBatch, getVaultStats } from "@kunalabs-io/kai";
import { getSuiClient } from "../client.ts";
import { log } from "../../lib/logger.ts";
import type { ApySnapshot } from "./types.ts";
import { canonicalType } from "./typeNorm.ts";
import {
  KAI_SAV_MAINNET,
  KAI_VAULTS,
  getKaiVaultByUnderlying,
} from "./kaiVaults.ts";

/**
 * Thin adapter over @kunalabs-io/kai for the single-asset-vault (SAV) product.
 *
 * Vault metadata is hardcoded in kaiVaults.ts (cdpm_web pattern) to avoid
 * importing VAULTS / SUPPLY_POOL_STRATEGY_INFOS / getPublishedAt from the SDK.
 * Those imports drag in Aftermath's top-level ESM side-effect which breaks
 * under Bun's CJS loader. Only getVaultDataBatch + getVaultStats are pure
 * algorithm functions safe to import.
 *
 * Design note: the Kai SDK pins @mysten/sui@1.45.0 while this project uses
 * @mysten/sui@^2.16.0. All move calls are hand-built in tx_lending.ts against
 * KAI_SAV_MAINNET.PUBLISHED_AT; this adapter is read-only metadata + APY.
 */

export interface KaiStrategyDescriptor {
  /** Strategy object id (`0x...`). */
  id: string;
  /** Underlying coin type T (same as the vault). */
  tType: string;
  /** Supply token type ST (specific to the strategy). */
  stType: string;
  /** Yield token type YT (same as the vault). */
  ytType: string;
  /** Supply pool object id this strategy is bound to. */
  supplyPoolId: string;
}

export interface KaiVaultMeta {
  vaultId: string;
  coinType: string;
  ytType: string;
  strategies: KaiStrategyDescriptor[];
}

export interface KaiAdapter {
  /** kai-sav package id at current publish (PUBLISHED_AT constant). */
  savPackageId(): string;
  /** Returns vault metadata for the given underlying coin type, or null if unsupported. */
  metaOf(coinType: string): KaiVaultMeta | null;
  /** Underlying APY (decimal). null if vault is paused / not loaded. */
  getSupplyApy(coinType: string): Promise<ApySnapshot | null>;
}

let cached: KaiAdapter | null = null;

export function getKaiAdapter(): KaiAdapter {
  if (cached) return cached;

  const adapter: KaiAdapter = {
    savPackageId(): string {
      return KAI_SAV_MAINNET.PUBLISHED_AT;
    },

    metaOf(coinType: string): KaiVaultMeta | null {
      const entry = getKaiVaultByUnderlying(canonicalType(coinType));
      if (!entry) return null;
      return {
        vaultId: entry.vaultId,
        coinType: entry.underlyingType,
        ytType: entry.ytType,
        strategies: [
          {
            id: entry.strategyId,
            tType: entry.underlyingType,
            stType: entry.stType,
            ytType: entry.ytType,
            supplyPoolId: entry.supplyPoolId,
          },
        ],
      };
    },

    async getSupplyApy(coinType: string): Promise<ApySnapshot | null> {
      const entry = getKaiVaultByUnderlying(canonicalType(coinType));
      if (!entry) return null;
      try {
        const client = getSuiClient();
        const [vaultData] = await getVaultDataBatch(
          client as unknown as Parameters<typeof getVaultDataBatch>[0],
          [entry.vaultId],
        );
        if (!vaultData) return null;
        const stats = getVaultStats(vaultData);
        return {
          protocol: "kai",
          coinType,
          apy: Number(stats.apy ?? 0),
          observedAtMs: Date.now(),
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn("kai: getSupplyApy failed", { coinType, error: msg });
        return null;
      }
    },
  };

  cached = adapter;
  return adapter;
}

// Re-export vault list for callers that need to enumerate supported coins
// (e.g. lendingPolicy bootstrap, APY cache warm-up).
export { KAI_VAULTS } from "./kaiVaults.ts";
