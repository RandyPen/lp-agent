/**
 * Named registry for liquidity strategies. The rebalancer + backtest CLI
 * resolve strategies by name through this single seam — adding a new
 * strategy is a one-line registration here, not a switch-statement edit
 * scattered across consumers.
 */

import type { Strategy } from "./types.ts";
import { createSingleBinStrategy } from "./singleBin.ts";
import { createMultiBinSpotStrategy } from "./multiBinSpot.ts";

export type StrategyName =
  | "singleBin"
  | "multiBinSpot";

const BUILDERS: Record<StrategyName, () => Strategy> = {
  singleBin: () => createSingleBinStrategy(),
  multiBinSpot: () => createMultiBinSpotStrategy(),
};

/** Build a strategy by name. Throws when the name is unknown. */
export function buildStrategy(name: StrategyName): Strategy {
  const build = BUILDERS[name];
  if (!build) {
    throw new Error(`unknown strategy: ${name}`);
  }
  return build();
}

export function isStrategyName(name: string): name is StrategyName {
  return name in BUILDERS;
}

export function listStrategyNames(): StrategyName[] {
  return Object.keys(BUILDERS) as StrategyName[];
}
