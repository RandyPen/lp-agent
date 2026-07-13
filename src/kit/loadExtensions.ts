/**
 * Loads a fork's `agent.config.ts` and registers whatever it declares.
 *
 * MUST run before `loadConfig()`: config validates STRATEGY / POOL_PROFILE /
 * PRICE_FEED against the registries, so the fork's entries have to be in them
 * by then. Every entrypoint that resolves one of those names calls this first
 * (src/index.ts, src/shadowStandalone.ts, src/backtest/cli.ts).
 *
 * Error policy, deliberately asymmetric:
 *   - config file ABSENT  → built-ins only. This is the normal state of a
 *     fresh clone and of the reference agent itself, so it is a documented,
 *     intentional condition, not a failure.
 *   - config file PRESENT but broken (throws, bad default export, duplicate
 *     name) → the error propagates and the process dies. A custody agent must
 *     never silently fall back to a different strategy than the one the
 *     operator configured. There is no try/catch here on purpose.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ConfigError } from "../lib/errors.ts";
import { log } from "../lib/logger.ts";
import { registerStrategy } from "../strategies/registry.ts";
import { registerPool } from "../pools/index.ts";
import { registerPriceFeed } from "../data/feedRegistry.ts";
import type { AgentExtensions } from "./defineAgent.ts";
import type { PredictionProvider } from "../prediction/provider.ts";
import type { AlertSink } from "../alerts/types.ts";

const DEFAULT_CONFIG_PATH = "./agent.config.ts";

/** Set by loadExtensions when the fork supplies a prediction provider. */
let customPrediction: (() => PredictionProvider) | null = null;
/** Set by loadExtensions when the fork supplies extra alert sinks. */
let customAlerts: AlertSink[] | null = null;

/**
 * The fork's prediction provider factory, or null when it did not declare one.
 * Read by src/index.ts when it wires the ML graph.
 */
export function getCustomPredictionProvider(): (() => PredictionProvider) | null {
  return customPrediction;
}

/** Extra alert sinks the fork registered, or null. */
export function getCustomAlertSinks(): AlertSink[] | null {
  return customAlerts;
}

let loaded = false;

/** Test-only: forget that extensions were loaded. */
export function resetExtensionsForTests(): void {
  loaded = false;
  customPrediction = null;
  customAlerts = null;
}

/**
 * Import `agent.config.ts` (override with AGENT_CONFIG) and register its
 * contents. Idempotent: a second call is a no-op, so entrypoints can call it
 * unconditionally without double-registering (which would throw).
 */
export async function loadExtensions(): Promise<void> {
  if (loaded) return;

  const configPath = resolve(process.env.AGENT_CONFIG ?? DEFAULT_CONFIG_PATH);

  if (!existsSync(configPath)) {
    loaded = true;
    log.info("kit: no agent.config.ts — running with built-in strategies/pools/feeds only", {
      lookedFor: configPath,
    });
    return;
  }

  // No try/catch: a broken user config must fail loudly, not degrade.
  const mod = (await import(configPath)) as { default?: AgentExtensions };
  const ext = mod.default;

  if (!ext || typeof ext !== "object") {
    throw new ConfigError(
      `${configPath} must have a default export produced by defineAgent(...). ` +
        `Got: ${ext === undefined ? "no default export" : typeof ext}.`,
    );
  }

  // Construct one throwaway instance to learn the name, then register the
  // FACTORY — so every consumer (live rebalancer, shadow fleet, backtest) gets
  // its own instance, as the built-ins do.
  for (const factory of ext.strategies ?? []) {
    registerStrategy(factory().name, factory);
  }

  for (const pool of ext.pools ?? []) {
    registerPool(pool.name, pool.build);
  }

  for (const [name, build] of Object.entries(ext.feeds ?? {})) {
    registerPriceFeed(name, build);
  }

  if (ext.prediction) {
    customPrediction = ext.prediction;
  }

  if (ext.alerts && ext.alerts.length > 0) {
    customAlerts = ext.alerts;
  }

  // Only now: a config that threw above must stay unloaded, so a retry
  // re-throws instead of silently yielding built-ins.
  loaded = true;

  log.info("kit: loaded agent.config.ts", {
    path: configPath,
    strategies: (ext.strategies ?? []).map((f) => f().name),
    pools: (ext.pools ?? []).map((p) => p.name),
    feeds: Object.keys(ext.feeds ?? {}),
    prediction: ext.prediction ? "custom" : "default",
  });
}
