import { loadConfig } from "../../config.ts";
import type { ApySnapshot, LendingProtocol } from "./types.ts";
import { getScallopAdapter } from "./scallop.ts";
import { getKaiAdapter } from "./kai.ts";
import { canonicalType } from "./typeNorm.ts";

/**
 * In-memory TTL cache around Scallop/Kai APY lookups. Each tick the router asks
 * for `getApy(protocol, coinType)`; we serve from cache when fresh, otherwise
 * fetch concurrently. SDK calls hit upstream RPC + APIs and shouldn't run every
 * 60s rebalancer heartbeat.
 *
 * A legitimate `null` result (e.g. the coin isn't listed on the protocol) is
 * cached just like a real snapshot — otherwise the TTL never actually bounds
 * RPC load for coins that simply aren't supported. A fetch ERROR is a
 * different thing entirely: it is never cached and never coerced to `null`
 * here — it propagates to the caller so the real cause stays visible (house
 * rule: no silent fallbacks). Only the adapters' own logging (`scallop.ts` /
 * `kai.ts`) decide whether a lookup failure becomes a thrown error or a
 * legitimate `null`; this cache does not reinterpret that.
 */

interface CacheEntry {
  snapshot: ApySnapshot | null;
  observedAtMs: number;
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
  if (hit && now - hit.observedAtMs < cfg.lending.apyCacheTtlMs) {
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
      // Cache both real snapshots and legitimate nulls — only a thrown error
      // (below) skips the cache.
      cache.set(key, { snapshot, observedAtMs: Date.now() });
      return snapshot;
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
