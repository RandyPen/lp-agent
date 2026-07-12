/**
 * Named registry for price feeds.
 *
 * `PriceFeed` was always a clean interface, but the only way to select an
 * implementation used to be a `switch` in src/index.ts whose `pyth` arm called
 * process.exit(1) — documented as an extension point while not being one. A
 * fork now registers its own feed from `agent.config.ts` and selects it with
 * PRICE_FEED=<name>.
 *
 * Builders take the resolved PoolProfile because every feed needs the pool's
 * decimals/orientation to produce a decimal-adjusted quote price.
 */

import { ConfigError } from "../lib/errors.ts";
import { createRegistry } from "../kit/registry.ts";
import type { PoolProfile } from "../pools/types.ts";
import type { PriceFeed } from "./priceFeed.ts";
import { createOnchainPriceFeed } from "./feeds/onchain.ts";
import { createBinancePriceFeed } from "./feeds/binance.ts";

export type PriceFeedBuilder = (profile: PoolProfile) => PriceFeed;

const registry = createRegistry<PriceFeedBuilder>("price feed", {
  onchain: (profile) => createOnchainPriceFeed(profile),
  binance: (profile) => createBinancePriceFeed(profile),
});

export const registerPriceFeed = registry.register;
export const isPriceFeedName = registry.has;
export const listPriceFeedNames = registry.list;
export const resetCustomFeedsForTests = registry.resetCustomForTests;

export function buildPriceFeed(name: string, profile: PoolProfile): PriceFeed {
  const build = registry.lookup(name);
  if (!build) {
    throw new ConfigError(
      `unknown PRICE_FEED='${name}'. available: ${listPriceFeedNames().join(", ")}. ` +
        `To add your own (e.g. Pyth), export it from agent.config.ts (see agent.config.example.ts).`,
    );
  }
  return build(profile);
}
