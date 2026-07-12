/**
 * Shared machinery behind every extension seam.
 *
 * Strategies, pools and feeds all need the same table-of-builtins +
 * table-of-fork-entries + collision-checked registration. Only *resolution*
 * differs (mlAgent needs deps, loadPoolProfile can require a poolId,
 * buildPriceFeed takes a profile), so that stays in each module.
 *
 * Generic over the BUILDER, so `() => Strategy`, `() => PoolProfile` and
 * `(p: PoolProfile) => PriceFeed` all fit.
 */

import { ConfigError } from "../lib/errors.ts";

export interface Registry<B> {
  register(name: string, build: B): void;
  has(name: string): boolean;
  lookup(name: string): B | undefined;
  /** Built-ins first, then fork-registered. */
  list(): string[];
  resetCustomForTests(): void;
}

/** @param kind noun used in errors: "strategy", "pool profile", "price feed". */
export function createRegistry<B>(kind: string, builtins: Record<string, B>): Registry<B> {
  const custom = new Map<string, B>();

  return {
    // Shadowing is never allowed to be quiet: a silently overridden strategy
    // means the agent trades code the operator didn't know was live.
    register(name, build) {
      if (name in builtins) {
        throw new ConfigError(
          `cannot register ${kind} '${name}': that name is built in. Pick another name.`,
        );
      }
      if (custom.has(name)) {
        throw new ConfigError(`${kind} '${name}' is already registered`);
      }
      custom.set(name, build);
    },

    has: (name) => name in builtins || custom.has(name),
    lookup: (name) => custom.get(name) ?? builtins[name],
    list: () => [...Object.keys(builtins), ...custom.keys()],
    resetCustomForTests: () => custom.clear(),
  };
}
