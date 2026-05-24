import { ConfigError } from "../lib/errors.ts";
import { buildSuiUsdcProfile } from "./sui-usdc.ts";
import type { PoolProfile } from "./types.ts";

/**
 * Pool profiles are built on demand so env-var-driven fields resolve at
 * `loadConfig` time rather than module-load time — important for tests that
 * set env after import, and for any caller mutating env at runtime.
 */
const BUILDERS: Record<string, () => PoolProfile> = {
  "sui-usdc": buildSuiUsdcProfile,
};

export function loadPoolProfile(name: string): PoolProfile {
  const build = BUILDERS[name];
  if (!build) {
    throw new ConfigError(
      `unknown POOL_PROFILE='${name}'. available: ${Object.keys(BUILDERS).join(", ")}`,
    );
  }
  const profile = build();
  if (!profile.poolId) {
    throw new ConfigError(
      `POOL_PROFILE='${name}' has empty poolId; set the appropriate env var (see src/pools/${name}.ts)`,
    );
  }
  return profile;
}

export type { PoolProfile } from "./types.ts";
