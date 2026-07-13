/**
 * The fork seam.
 *
 * A fork's strategies, pools, feeds and prediction model are declared in
 * `agent.config.ts` at the repo root — a file the framework never writes to.
 * That is what makes upstream pulls conflict-free (registering used to mean
 * editing src/strategies/registry.ts, src/pools/index.ts and src/index.ts).
 *
 * Commit `agent.config.ts` and `user/` to your fork like any other source: the
 * conflict-freedom comes from upstream not touching those paths, not from
 * gitignoring them.
 *
 *   // agent.config.ts
 *   import { defineAgent } from "./src/kit/defineAgent.ts";
 *   import { createMyStrategy } from "./user/myStrategy.ts";
 *
 *   export default defineAgent({ strategies: [createMyStrategy()] });
 *
 * Then: STRATEGY=myStrategy bun start
 */

import type { Strategy } from "../strategies/types.ts";
import type { PoolProfile } from "../pools/types.ts";
import type { PriceFeedBuilder } from "../data/feedRegistry.ts";
import type { PredictionProvider } from "../prediction/provider.ts";
import type { AlertSink } from "../alerts/types.ts";

export interface AgentExtensions {
  /**
   * Strategy FACTORIES, selected with STRATEGY / FALLBACK_STRATEGY /
   * SHADOW_FLEET. Pass `() => createMyStrategy()`, not `createMyStrategy()`.
   *
   * Factories, not instances, because the framework builds a strategy per
   * consumer: the live rebalancer, the shadow fleet, and the backtest each call
   * buildStrategy() separately. Handing them one shared object would let a
   * stateful strategy leak state between PMs, and between the live book and the
   * shadow book that exists to validate it. The built-ins are registered as
   * factories for exactly this reason.
   */
  strategies?: Array<() => Strategy>;

  /**
   * Selected with POOL_PROFILE=<name>. `build` is lazy so env-driven fields
   * (pool ids, coin types) resolve when config loads, not at import.
   */
  pools?: Array<{ name: string; build: () => PoolProfile }>;

  /** Keyed by the name PRICE_FEED selects. Built-ins: onchain, binance. */
  feeds?: Record<string, PriceFeedBuilder>;

  /** The model behind `mlAgent`. Overrides PREDICTION_PROVIDER. */
  prediction?: () => PredictionProvider;

  /**
   * Extra alert sinks, ADDED to the built-ins (log + optional webhook) rather
   * than replacing them. Use this to page your own on-call system.
   * `send()` must never throw — see AlertSink.
   */
  alerts?: AlertSink[];
}

/** Identity function — exists so `agent.config.ts` gets type checking. */
export function defineAgent(ext: AgentExtensions): AgentExtensions {
  return ext;
}
