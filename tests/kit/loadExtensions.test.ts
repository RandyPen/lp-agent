/**
 * The loader's error policy is deliberately asymmetric, and that asymmetry is
 * the safety property worth testing:
 *
 *   absent config  → built-ins only (the normal state of a fresh clone)
 *   broken config  → throw, and let it kill the process
 *
 * A custody agent must never quietly run a different strategy than the one the
 * operator configured, so there is no try/catch in the loader and none here.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExtensions, resetExtensionsForTests, getCustomPredictionProvider } from "../../src/kit/loadExtensions.ts";
import { isStrategyName, resetCustomStrategiesForTests } from "../../src/strategies/registry.ts";
import { resetCustomPoolsForTests } from "../../src/pools/index.ts";
import { isPriceFeedName, resetCustomFeedsForTests } from "../../src/data/feedRegistry.ts";

const dirs: string[] = [];
const prevConfig = process.env.AGENT_CONFIG;

function writeConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lp-agent-kit-"));
  dirs.push(dir);
  const path = join(dir, "agent.config.ts");
  writeFileSync(path, contents);
  return path;
}

/** Absolute import specifier for the repo's src/, usable from a temp dir. */
const SRC = join(import.meta.dir, "..", "..", "src");

afterEach(() => {
  resetExtensionsForTests();
  resetCustomStrategiesForTests();
  resetCustomPoolsForTests();
  resetCustomFeedsForTests();
  if (prevConfig === undefined) delete process.env.AGENT_CONFIG;
  else process.env.AGENT_CONFIG = prevConfig;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("loadExtensions", () => {
  it("is a no-op when there is no agent.config.ts — a fresh clone runs on built-ins", async () => {
    process.env.AGENT_CONFIG = join(tmpdir(), "definitely-not-here", "agent.config.ts");

    await loadExtensions();

    expect(isStrategyName("multiBinSpot")).toBe(true); // built-ins still there
    expect(getCustomPredictionProvider()).toBeNull();
  });

  it("registers strategies and feeds declared by the fork", async () => {
    process.env.AGENT_CONFIG = writeConfig(`
      import { defineAgent } from "${join(SRC, "kit", "defineAgent.ts")}";

      export default defineAgent({
        strategies: [{
          name: "forkStrat",
          async plan() { return { kind: "quiet", reason: "test" }; },
        }],
        feeds: {
          pyth: () => ({
            source: "pyth",
            async getSpot() { return { price: "1", timestampMs: 0, source: "pyth" }; },
            async getHistory() { return []; },
            async getOhlcv() { return []; },
          }),
        },
      });
    `);

    await loadExtensions();

    expect(isStrategyName("forkStrat")).toBe(true);
    expect(isPriceFeedName("pyth")).toBe(true);
  });

  it("THROWS when the config throws — it must not degrade to built-ins", async () => {
    process.env.AGENT_CONFIG = writeConfig(`throw new Error("boom in user config");`);

    await expect(loadExtensions()).rejects.toThrow(/boom in user config/);
  });

  it("a failed load stays unloaded — a retry re-throws instead of yielding built-ins", async () => {
    // Regression: `loaded = true` used to be set BEFORE the dynamic import, so a
    // config that threw marked itself loaded. A second call then returned
    // silently with only the built-ins registered — the exact silent-fallback
    // this loader exists to prevent.
    process.env.AGENT_CONFIG = writeConfig(`throw new Error("boom");`);

    await expect(loadExtensions()).rejects.toThrow(/boom/);
    await expect(loadExtensions()).rejects.toThrow(/boom/);
  });

  it("THROWS when the config has no default export", async () => {
    process.env.AGENT_CONFIG = writeConfig(`export const notDefault = 1;`);

    await expect(loadExtensions()).rejects.toThrow(/default export/);
  });

  it("THROWS when the fork tries to shadow a built-in strategy", async () => {
    process.env.AGENT_CONFIG = writeConfig(`
      import { defineAgent } from "${join(SRC, "kit", "defineAgent.ts")}";
      export default defineAgent({
        strategies: [{
          name: "multiBinSpot",
          async plan() { return { kind: "quiet", reason: "hijack" }; },
        }],
      });
    `);

    await expect(loadExtensions()).rejects.toThrow(/built in/);
  });

  it("is idempotent — entrypoints can call it unconditionally without double-registering", async () => {
    process.env.AGENT_CONFIG = writeConfig(`
      import { defineAgent } from "${join(SRC, "kit", "defineAgent.ts")}";
      export default defineAgent({
        strategies: [{
          name: "once",
          async plan() { return { kind: "quiet", reason: "test" }; },
        }],
      });
    `);

    await loadExtensions();
    await loadExtensions(); // would throw "already registered" if it re-ran

    expect(isStrategyName("once")).toBe(true);
  });
});
