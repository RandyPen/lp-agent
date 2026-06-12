/**
 * Named registry for liquidity strategies. The rebalancer + backtest CLI
 * resolve strategies by name through this single seam — adding a new
 * strategy is a one-line registration here, not a switch-statement edit
 * scattered across consumers.
 */

import type { Strategy } from "./types.ts";
import { createSingleBinStrategy } from "./singleBin.ts";
import { createMultiBinSpotStrategy } from "./multiBinSpot.ts";
import { createEmaTrendStrategy } from "./emaTrend.ts";
import { createMlAgentStrategy, type MlAgentDeps } from "./mlAgent.ts";
import { ConfigError } from "../lib/errors.ts";

export type StrategyName =
  | "singleBin"
  | "multiBinSpot"
  | "emaTrend"
  | "mlAgent";

// Re-export so callers that need to pass mlDeps don't need a second import.
export type { MlAgentDeps } from "./mlAgent.ts";

/**
 * All rule-based (non-ML) strategies can be built with no extra deps.
 * mlAgent is excluded here and handled explicitly in buildStrategy.
 */
const BUILDERS: Record<Exclude<StrategyName, "mlAgent">, () => Strategy> = {
  singleBin: () => createSingleBinStrategy(),
  multiBinSpot: () => createMultiBinSpotStrategy(),
  emaTrend: () => createEmaTrendStrategy(),
};

/**
 * Build a strategy by name.
 *
 * - Rule-based strategies (singleBin, multiBinSpot, emaTrend): `mlDeps` is
 *   ignored.
 * - "mlAgent": `mlDeps` is required. Throws `ConfigError` when absent.
 */
export function buildStrategy(name: StrategyName, mlDeps?: MlAgentDeps): Strategy {
  if (name === "mlAgent") {
    if (!mlDeps) {
      throw new ConfigError(
        "buildStrategy('mlAgent') requires mlDeps; pass a MlAgentDeps object as the second argument",
      );
    }
    return createMlAgentStrategy(mlDeps);
  }

  const build = BUILDERS[name];
  if (!build) {
    throw new ConfigError(`unknown strategy: ${name}`);
  }
  return build();
}

export function isStrategyName(name: string): name is StrategyName {
  return name === "mlAgent" || name in BUILDERS;
}

export function listStrategyNames(): StrategyName[] {
  return [...Object.keys(BUILDERS) as Exclude<StrategyName, "mlAgent">[], "mlAgent"];
}
