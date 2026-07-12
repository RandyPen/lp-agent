/**
 * Keyless standalone entrypoint for the shadow fleet — for running the
 * simulation on a remote box WITHOUT any secrets.
 *
 * The shadow fleet only needs public reads (Sui fullnode RPC + Binance
 * public klines), so this entry deliberately does NOT go through
 * loadConfig(): no mnemonics, no EXPECTED_*_ADDRESS, no identity files —
 * nothing worth stealing ever lands on the sim host (house rule: .env is
 * never copied between machines).
 *
 * Env (all optional except the pool id):
 *   SUI_USDC_POOL_ID          DLMM pool object id (required)
 *   SHADOW_FLEET              default "presenceAnchor,presenceSweep"
 *   SHADOW_FLEET_INITIAL_A/B  raw physical units (default ≈65 USDC / 46.67 SUI)
 *   SHADOW_DB_FILE            default ./data/shadow.db
 *   SUI_RPC_URL               default https://fullnode.mainnet.sui.io:443
 *   SUI_EVENTS_RPC_URL        endpoint for queryEvents (the fleet's ONLY RPC
 *                             call). Falls back to SUI_RPC_URL. Needed when
 *                             the local fullnode runs WITHOUT extended object
 *                             indexing (queryEvents is an indexer feature) —
 *                             e.g. the Germany box's node as of 2026-07.
 *
 * Run: bun run src/shadowStandalone.ts
 */

import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { openDb } from "./db/client.ts";
import { createBinancePriceFeed } from "./data/feeds/binance.ts";
import { createShadowFleet } from "./services/shadowFleet.ts";
import { loadPoolProfile } from "./pools/index.ts";
import { loadExtensions } from "./kit/loadExtensions.ts";
import { isStrategyName, listStrategyNames, type StrategyName } from "./strategies/registry.ts";
import { log } from "./lib/logger.ts";

async function main(): Promise<void> {
  // Register the fork's strategies/pools before any name is resolved below.
  await loadExtensions();

  // Goes through the pool registry (not buildSuiUsdcProfile directly) so a
  // fork can shadow its own pool with POOL_PROFILE=<name>.
  const profile = loadPoolProfile(process.env.POOL_PROFILE ?? "sui-usdc");

  const namesRaw = process.env.SHADOW_FLEET?.trim() || "presenceAnchor,presenceSweep";
  const strategies: StrategyName[] = [];
  for (const name of namesRaw.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (!isStrategyName(name) || name === "mlAgent") {
      throw new Error(
        `shadowStandalone: unsupported shadow strategy '${name}'. ` +
          `Available: ${listStrategyNames().filter((n) => n !== "mlAgent").join(", ")} ` +
          `(mlAgent needs the live prediction graph and cannot run in the fleet).`,
      );
    }
    strategies.push(name);
  }

  const dbFile = process.env.SHADOW_DB_FILE ?? "./data/shadow.db";
  const db = openDb(dbFile);
  const priceFeed = createBinancePriceFeed(profile);

  const fleet = createShadowFleet({
    db,
    profile,
    priceFeed,
    strategies,
    initialA: BigInt(process.env.SHADOW_FLEET_INITIAL_A ?? "65000000"),
    initialB: BigInt(process.env.SHADOW_FLEET_INITIAL_B ?? "46670000000"),
    // getSuiClient() would drag in loadConfig — standalone builds its own.
    // queryEvents needs an INDEXING endpoint; SUI_EVENTS_RPC_URL overrides
    // when the primary node runs without extended object indexing.
    clientOverride: new SuiJsonRpcClient({
      url:
        process.env.SUI_EVENTS_RPC_URL ??
        process.env.SUI_RPC_URL ??
        "https://fullnode.mainnet.sui.io:443",
      network: "mainnet",
    }),
  });

  const stop = fleet.start();
  log.info("shadowStandalone: running", { strategies, dbFile, poolId: profile.poolId });

  const teardown = (sig: string) => {
    log.info("shadowStandalone: shutting down", { sig });
    stop();
    process.exit(0);
  };
  process.once("SIGINT", () => teardown("SIGINT"));
  process.once("SIGTERM", () => teardown("SIGTERM"));
}

main().catch((err: unknown) => {
  log.error("shadowStandalone: fatal error", {
    error: err instanceof Error ? (err.stack ?? err.message) : String(err),
  });
  process.exit(1);
});
