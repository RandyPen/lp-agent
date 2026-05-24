import { loadConfig } from "../../config.ts";
import { log } from "../../lib/logger.ts";
import type { ApySnapshot, LendingProtocol } from "./types.ts";
import { getScallopAdapter } from "./scallop.ts";
import { getKaiAdapter } from "./kai.ts";
import { canonicalType } from "./typeNorm.ts";

/**
 * In-memory TTL cache around Scallop/Kai APY lookups. Each tick the router asks
 * for `getApy(protocol, coinType)`; we serve from cache when fresh, otherwise
 * fetch concurrently. SDK calls hit upstream RPC + APIs and shouldn't run every
 * 60s rebalancer heartbeat.
 */

interface CacheEntry {
  snapshot: ApySnapshot;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<ApySnapshot | null>>();

function keyOf(protocol: LendingProtocol, coinType: string): string {
  return `${protocol}|${canonicalType(coinType)}`;
}

export async function getApy(
  protocol: LendingProtocol,
  coinType: string,
): Promise<ApySnapshot | null> {
  const cfg = loadConfig();
  const key = keyOf(protocol, coinType);
  const now = Date.now();

  const hit = cache.get(key);
  if (hit && now - hit.snapshot.observedAtMs < cfg.lending.apyCacheTtlMs) {
    return hit.snapshot;
  }

  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = (async (): Promise<ApySnapshot | null> => {
    try {
      const snapshot =
        protocol === "scallop"
          ? await getScallopAdapter().getSupplyApy(coinType)
          : await getKaiAdapter().getSupplyApy(coinType);
      if (snapshot) {
        cache.set(key, { snapshot });
      }
      return snapshot;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn("apyCache: fetch failed", { protocol, coinType, error: msg });
      return null;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

export function resetApyCacheForTests(): void {
  cache.clear();
  inflight.clear();
}
