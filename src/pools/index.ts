import { ConfigError } from "../lib/errors.ts";
import { createRegistry } from "../kit/registry.ts";
import { buildSuiUsdcProfile } from "./sui-usdc.ts";
import type { PoolProfile } from "./types.ts";

/**
 * Profiles are built on demand so env-driven fields resolve at `loadConfig`
 * time, not module-load time. A `PoolProfile` is pure data, so a fork registers
 * one from its own `agent.config.ts` rather than editing this file.
 */
const registry = createRegistry<() => PoolProfile>("pool profile", {
  "sui-usdc": buildSuiUsdcProfile,
});

export const registerPool = registry.register;
export const listPoolNames = registry.list;
export const resetCustomPoolsForTests = registry.resetCustomForTests;

export interface LoadPoolProfileOptions {
  /**
   * Require a non-empty on-chain `poolId` (default: true). Set false only for
   * consumers that use the profile purely as metadata and never touch the
   * chain — the offline backtest is the one such caller, and forcing
   * SUI_USDC_POOL_ID on it would make a keyless replay impossible.
   */
  requirePoolId?: boolean;
}

export function loadPoolProfile(
  name: string,
  opts: LoadPoolProfileOptions = {},
): PoolProfile {
  const build = registry.lookup(name);
  if (!build) {
    throw new ConfigError(
      `unknown POOL_PROFILE='${name}'. available: ${listPoolNames().join(", ")}. ` +
        `To add your own, export it from agent.config.ts (see agent.config.example.ts).`,
    );
  }
  const profile = build();
  if ((opts.requirePoolId ?? true) && !profile.poolId) {
    throw new ConfigError(
      `POOL_PROFILE='${name}' has empty poolId; set the appropriate env var (see src/pools/${name}.ts)`,
    );
  }
  return profile;
}

export type { PoolProfile } from "./types.ts";
