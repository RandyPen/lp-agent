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
 *
 * Run: bun run src/shadowStandalone.ts
 */

import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { openDb } from "./db/client.ts";
import { createBinancePriceFeed } from "./data/feeds/binance.ts";
import { createShadowFleet } from "./services/shadowFleet.ts";
import { buildSuiUsdcProfile } from "./pools/sui-usdc.ts";
import { isStrategyName, type StrategyName } from "./strategies/registry.ts";
import { log } from "./lib/logger.ts";

function main(): void {
  const profile = buildSuiUsdcProfile();
  if (!profile.poolId) {
    throw new Error("shadowStandalone: SUI_USDC_POOL_ID must be set");
  }

  const namesRaw = process.env.SHADOW_FLEET?.trim() || "presenceAnchor,presenceSweep";
  const strategies: StrategyName[] = [];
  for (const name of namesRaw.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (!isStrategyName(name) || name === "mlAgent") {
      throw new Error(`shadowStandalone: unsupported shadow strategy '${name}'`);
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
    clientOverride: new SuiJsonRpcClient({
      url: process.env.SUI_RPC_URL ?? "https://fullnode.mainnet.sui.io:443",
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

main();
