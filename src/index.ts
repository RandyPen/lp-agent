import { loadConfig } from "./config.ts";
import { openDb } from "./db/client.ts";
import { getAgentAddress } from "./sui/keypair.ts";
import { createOnchainPriceFeed } from "./data/feeds/onchain.ts";
import { createSubscriptionsService } from "./services/subscriptions.ts";
import { createExecutorService } from "./services/executor.ts";
import { createRebalancerService } from "./services/rebalancer.ts";
import { startTreasuryService, type TreasuryService } from "./services/treasuryService.ts";
import { log } from "./lib/logger.ts";

async function main(): Promise<void> {
  // 1. Load config — fails fast on missing env vars.
  const cfg = loadConfig();

  // 2. Open and migrate the database.
  openDb(cfg.dbFile);

  // 3. Resolve the agent keypair. `getAgentAddress` internally enforces
  // EXPECTED_AGENT_ADDRESS when set (see src/sui/keypairs/agent.ts).
  let agentAddress: string;
  try {
    agentAddress = getAgentAddress();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("liquidity-manager: agent key resolution failed", { error: msg });
    process.exit(1);
  }

  log.info("liquidity-manager starting", {
    network: cfg.network,
    agentAddress,
    poolId: cfg.poolProfile.poolId,
    poolName: cfg.poolProfile.name,
    priceFeed: cfg.priceFeed,
  });

  // 4. Create the price feed. Only "onchain" is implemented in P0.
  if (cfg.priceFeed !== "onchain") {
    log.error("price feed not yet implemented", { priceFeed: cfg.priceFeed });
    process.exit(1);
  }
  const priceFeed = createOnchainPriceFeed(cfg.poolProfile);

  // 5. Create and initially poll subscriptions so we backfill on first start.
  const subscriptionsService = createSubscriptionsService();
  const initial = await subscriptionsService.pollOnce();
  log.info("subscriptions: initial poll complete", initial);

  // 6. Schedule recurring subscription polling.
  const subHandle = setInterval(() => {
    subscriptionsService.pollOnce().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("subscriptions: poll failed", { error: msg });
    });
  }, cfg.eventPollIntervalMs);

  // 7. Create and start the rebalancer.
  const executorService = createExecutorService();
  const rebalancerService = createRebalancerService(
    subscriptionsService,
    executorService,
    priceFeed,
  );
  const stopRebalancer = rebalancerService.start();

  // 8. Treasury (opt-in via TREASURY_ENABLED=true). Watcher polls every
  // registered user's deposit address for inbound balance deltas; charges
  // are issued directly by the rebalancer via `src/treasury/charges.ts`.
  let treasuryService: TreasuryService | null = null;
  if (cfg.treasury.enabled) {
    try {
      treasuryService = startTreasuryService(cfg.treasury);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("treasury: failed to start", { error: msg });
      process.exit(1);
    }
  } else {
    log.info("treasury: disabled (TREASURY_ENABLED=false)");
  }

  log.info("liquidity-manager running");

  // 9. Graceful shutdown on SIGINT / SIGTERM.
  function shutdown(signal: string): void {
    log.info("received signal, shutting down", { signal });
    clearInterval(subHandle);
    stopRebalancer();
    treasuryService?.stop();
    log.info("liquidity-manager stopped");
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  log.error("liquidity-manager fatal error", { error: msg });
  process.exit(1);
});
