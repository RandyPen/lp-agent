/**
 * Named registry for liquidity strategies — the rebalancer, backtest CLI and
 * shadow fleet all resolve by name through it.
 *
 * A fork adds a strategy WITHOUT editing this file: it registers one from its
 * own `agent.config.ts` (see src/kit/defineAgent.ts). The trade is that an
 * unknown STRATEGY is caught at startup rather than by the compiler — for a
 * typo, the same failed boot, one second later.
 */

import type { Strategy } from "./types.ts";
import { createSingleBinStrategy } from "./singleBin.ts";
import { createMultiBinSpotStrategy } from "./multiBinSpot.ts";
import { createPresenceAnchorStrategy } from "./presenceAnchor.ts";
import { createPresenceSweepStrategy } from "./presenceSweep.ts";
import { createMlAgentStrategy, type MlAgentDeps } from "./mlAgent.ts";
import { createRegistry } from "../kit/registry.ts";
import { ConfigError } from "../lib/errors.ts";

/**
 * A strategy name. Any string a fork has registered is valid, so this is an
 * alias rather than a union — validate with `isStrategyName()` at runtime, not
 * with the type system.
 */
export type StrategyName = string;

/** The strategies that ship with the framework. */
export const BUILTIN_STRATEGY_NAMES = [
  "singleBin",
  "multiBinSpot",
  "presenceAnchor",
  "presenceSweep",
  "mlAgent",
] as const;

export type BuiltinStrategyName = (typeof BUILTIN_STRATEGY_NAMES)[number];

// Re-export so callers that need to pass mlDeps don't need a second import.
export type { MlAgentDeps } from "./mlAgent.ts";

/**
 * Built-in rule-based strategies — all constructible with no extra deps.
 * `mlAgent` is NOT in the registry: it needs MlAgentDeps, so it is special-cased
 * in buildStrategy and added back in the name-facing helpers below.
 */
const registry = createRegistry<() => Strategy>("strategy", {
  singleBin: () => createSingleBinStrategy(),
  multiBinSpot: () => createMultiBinSpotStrategy(),
  presenceAnchor: () => createPresenceAnchorStrategy(),
  presenceSweep: () => createPresenceSweepStrategy(),
});

export function registerStrategy(name: string, build: () => Strategy): void {
  // mlAgent lives outside the registry, so guard it explicitly.
  if (name === "mlAgent") {
    throw new ConfigError(
      `cannot register strategy 'mlAgent': that name is built in. Pick another name.`,
    );
  }
  registry.register(name, build);
}

/** Test-only: drop all fork-registered strategies. */
export function resetCustomStrategiesForTests(): void {
  registry.resetCustomForTests();
}

/**
 * Build a strategy by name.
 *
 * - "mlAgent" requires `mlDeps`; throws `ConfigError` when absent.
 * - Every other strategy (built-in or fork-registered) ignores `mlDeps`.
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

  const build = registry.lookup(name);
  if (!build) {
    throw new ConfigError(
      `unknown strategy: '${name}'. Registered: ${listStrategyNames().join(", ")}. ` +
        `To add your own, export it from agent.config.ts (see agent.config.example.ts).`,
    );
  }
  return build();
}

export function isStrategyName(name: string): boolean {
  return name === "mlAgent" || registry.has(name);
}

/** All registered names — built-ins first, then fork-registered. */
export function listStrategyNames(): StrategyName[] {
  return [...registry.list(), "mlAgent"];
}
