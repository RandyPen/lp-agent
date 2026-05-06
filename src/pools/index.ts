import { ConfigError } from "../lib/errors.ts";
import { SUI_USDC } from "./sui-usdc.ts";
import type { PoolProfile } from "./types.ts";

const PROFILES: Record<string, PoolProfile> = {
  "sui-usdc": SUI_USDC,
};

export function loadPoolProfile(name: string): PoolProfile {
  const profile = PROFILES[name];
  if (!profile) {
    throw new ConfigError(
      `unknown POOL_PROFILE='${name}'. available: ${Object.keys(PROFILES).join(", ")}`,
    );
  }
  if (!profile.poolId) {
    throw new ConfigError(
      `POOL_PROFILE='${name}' has empty poolId; set the appropriate env var (see src/pools/${name}.ts)`,
    );
  }
  return profile;
}

export type { PoolProfile } from "./types.ts";
