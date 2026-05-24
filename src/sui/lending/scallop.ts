import { Scallop } from "@scallop-io/sui-scallop-sdk";
import type { ScallopQuery } from "@scallop-io/sui-scallop-sdk";
import { loadConfig } from "../../config.ts";
import { log } from "../../lib/logger.ts";
import type { ApySnapshot, ScallopIds } from "./types.ts";
import { canonicalType } from "./typeNorm.ts";

/**
 * Thin adapter over @scallop-io/sui-scallop-sdk. Centralises:
 *   1. SDK lazy bootstrap (init() — pulls address bundle from Scallop API).
 *   2. Coin-type → Scallop "poolCoinName" mapping (using POOL_ADDRESSES from SDK).
 *   3. Supply-APY queries (used by router.ts).
 *   4. Runtime ID resolution for PTB construction.
 *
 * The CDPM hot-potato PTB calls Scallop's `mint::mint` / `redeem::redeem` directly;
 * this adapter never builds those move-calls itself. Its only job is to supply
 * the package id + version id + market id + coin name needed by tx_lending.ts.
 */

interface ScallopAdapter {
  init(): Promise<void>;
  /** Returns null when coinType isn't supported by Scallop. */
  resolveIds(): Promise<ScallopIds>;
  getSupplyApy(coinType: string): Promise<ApySnapshot | null>;
  /** Map coin type tag → Scallop "poolCoinName" (e.g. 'usdc', 'sui'). */
  coinNameOf(coinType: string): string | null;
}

let cached: ScallopAdapter | null = null;

export function getScallopAdapter(): ScallopAdapter {
  if (cached) return cached;
  cached = buildAdapter();
  return cached;
}

function buildAdapter(): ScallopAdapter {
  const cfg = loadConfig();
  const networkType = cfg.network === "mainnet" ? "mainnet" : cfg.network === "testnet" ? "testnet" : "devnet";

  // Lazy: we don't initialise the Scallop client until first use to avoid
  // blocking app startup on an upstream API call.
  let scallop: Scallop | null = null;
  let query: ScallopQuery | null = null;
  let ids: ScallopIds | null = null;
  let coinNameByType: Map<string, string> | null = null;

  async function ensureInit(): Promise<void> {
    if (scallop && query && ids && coinNameByType) return;
    log.debug("scallop: initialising SDK", { networkType });
    scallop = new Scallop({ networkType });
    await scallop.init();
    query = await scallop.createScallopQuery();

    // The address resolver lives on `scallop.client.address`; keys per cdpm-agent-sdk docs.
    // SDK types `AddressStringPath` as a string-literal union; we cast at the boundary.
    const inst = scallop;
    const get = (path: string): string =>
      inst.client.address.get(path as Parameters<typeof inst.client.address.get>[0]) as string;
    ids = {
      protocolPackageId: get("core.packages.protocol.id"),
      versionId: get("core.version"),
      marketId: get("core.market"),
    };
    if (!ids.protocolPackageId || !ids.versionId || !ids.marketId) {
      throw new Error(
        `scallop: failed to resolve protocol/version/market ids — address bundle incomplete`,
      );
    }

    coinNameByType = new Map();
    // POOL_ADDRESSES is a static export; we walk it via the live address bundle so
    // upgrades are absorbed transparently.
    const { POOL_ADDRESSES } = await import("@scallop-io/sui-scallop-sdk");
    for (const [name, entry] of Object.entries(POOL_ADDRESSES)) {
      const coinType = (entry as { coinType?: string }).coinType;
      if (typeof coinType === "string" && coinType.length > 0) {
        coinNameByType.set(canonicalType(coinType), name);
      }
    }
    log.info("scallop: SDK ready", {
      protocolPackageId: ids.protocolPackageId,
      versionId: ids.versionId,
      marketId: ids.marketId,
      pools: coinNameByType.size,
    });
  }

  return {
    async init(): Promise<void> {
      await ensureInit();
    },

    async resolveIds(): Promise<ScallopIds> {
      await ensureInit();
      return ids!;
    },

    coinNameOf(coinType: string): string | null {
      if (!coinNameByType) return null;
      return coinNameByType.get(canonicalType(coinType)) ?? null;
    },

    async getSupplyApy(coinType: string): Promise<ApySnapshot | null> {
      await ensureInit();
      const name = coinNameByType!.get(canonicalType(coinType));
      if (!name) return null;
      try {
        const pool = await query!.getMarketPool(name);
        // MarketPool exposes supplyApy as a decimal (e.g. 0.045).
        const apy = Number((pool as { supplyApy?: number }).supplyApy ?? 0);
        return { protocol: "scallop", coinType, apy, observedAtMs: Date.now() };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn("scallop: getSupplyApy failed", { coinType, name, error: msg });
        return null;
      }
    },
  };
}

