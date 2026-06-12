import { loadConfig } from "./config.ts";
import { openDb, getDb } from "./db/client.ts";
import { getAgentAddress } from "./sui/keypair.ts";
import { createOnchainPriceFeed } from "./data/feeds/onchain.ts";
import { createBinancePriceFeed } from "./data/feeds/binance.ts";
import type { PriceFeed } from "./data/priceFeed.ts";
import { createSubscriptionsService } from "./services/subscriptions.ts";
import { createExecutorService } from "./services/executor.ts";
import { createRebalancerService } from "./services/rebalancer.ts";
import { startTreasuryService, type TreasuryService } from "./services/treasuryService.ts";
import { log } from "./lib/logger.ts";

// ML / shadow mode imports — only used when STRATEGY=mlAgent.
import type { MlAgentDeps } from "./strategies/registry.ts";

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
    strategy: cfg.strategy,
    shadowMode: cfg.ml.shadowMode,
  });

  // 4. Create the price feed. Currently `onchain` (Cetus SwapEvent) and
  // `binance` (public Binance REST) are implemented; `pyth` is a stub for
  // downstream forks.
  let priceFeed: PriceFeed;
  switch (cfg.priceFeed) {
    case "onchain":
      priceFeed = createOnchainPriceFeed(cfg.poolProfile);
      break;
    case "binance":
      priceFeed = createBinancePriceFeed(cfg.poolProfile);
      break;
    case "pyth":
      log.error("price feed not yet implemented", { priceFeed: cfg.priceFeed });
      process.exit(1);
  }

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

  // 7a. Assemble mlDeps when strategy === "mlAgent".
  //     When shadow mode is enabled the mlAgent still runs through the full
  //     decision chain but the rebalancer's tickOne submits nothing (the live
  //     rule-based strategy continues to run; the shadow runner records what
  //     mlAgent WOULD have done).
  let mlDeps: MlAgentDeps | undefined;
  let stopShadowRunner: (() => void) | null = null;

  if (cfg.strategy === "mlAgent") {
    const { createMarketAggregator } = await import("./data/marketAggregator.ts");
    const { createBinanceMultiFeed } = await import("./data/feeds/binanceMulti.ts");
    const { createDerivativesFeed } = await import("./data/feeds/derivatives.ts");
    const { createCetusEventsFeed } = await import("./data/feeds/cetusEvents.ts");
    const { createStateMachine } = await import("./state/machine.ts");
    const { createRiskMonitor } = await import("./risk/monitor.ts");
    const { buildStrategy } = await import("./strategies/registry.ts");

    const db = getDb();

    // Build the market aggregator feeds.
    const binanceFeed = createBinanceMultiFeed();
    const derivFeed = createDerivativesFeed();
    const cetusFeed = createCetusEventsFeed({ poolId: cfg.poolProfile.poolId });

    const marketAggregator = createMarketAggregator({
      binance: binanceFeed,
      derivatives: derivFeed,
      cetus: cetusFeed,
    });

    // Start the feeds (returns a composite stop function).
    const stopFeeds = marketAggregator.start();

    // State machine — one per pool for this process.
    const stateMachine = createStateMachine({
      poolId: cfg.poolProfile.poolId,
      db,
    });

    // Risk monitor.
    const riskMonitor = createRiskMonitor({
      db,
      thresholds: cfg.risk.thresholds,
    });

    // Prediction provider: sidecar in production; null provider if sidecar not configured.
    let predictionProvider;
    {
      const { createSidecarPredictionProvider } = await import("./prediction/sidecarProvider.ts");
      predictionProvider = createSidecarPredictionProvider({
        baseUrl: cfg.prediction.sidecarUrl,
        timeoutMs: cfg.prediction.timeoutMs,
      });
    }

    // Fallback (Tier 0) strategy.
    const fallbackStrategy = buildStrategy(cfg.fallbackStrategy);

    mlDeps = {
      provider: predictionProvider,
      stateMachine,
      riskMonitor,
      marketAggregator,
      fallback: fallbackStrategy,
      db,
    };

    log.info("liquidity-manager: mlAgent wired up", {
      sidecarUrl: cfg.prediction.sidecarUrl,
      fallbackStrategy: cfg.fallbackStrategy,
      shadowMode: cfg.ml.shadowMode,
    });

    // 7b. Shadow runner — only when ML_SHADOW_MODE=true.
    if (cfg.ml.shadowMode) {
      const { createShadowRunner } = await import("./services/shadowRunner.ts");
      const { createMlAgentStrategy } = await import("./strategies/mlAgent.ts");

      const mlStrategy = createMlAgentStrategy(mlDeps);
      const ruleStrategyForShadow = buildStrategy(cfg.fallbackStrategy);
      const shadowRunner = createShadowRunner({
        mlStrategy,
        ruleStrategy: ruleStrategyForShadow,
        stateMachine,
        db,
      });

      // Run shadow ticks on the same interval as the rebalancer but independently.
      // The shadow runner never touches the chain.
      const shadowHandle = setInterval(() => {
        // Shadow ticks are best-effort: we can only run them when we have live
        // subscription data. Since this is shadow mode, just log if no subs.
        const subs = subscriptionsService.listActive();
        for (const sub of subs) {
          // We need a full StrategyInput to run the shadow tick. Build a minimal
          // one from subscription data; the strategy itself will fetch live data
          // via the market aggregator.
          //
          // NOTE: shadow mode ticks import and use getPositionManager/getPoolState
          // directly — they are read-only chain calls, not on-chain writes.
          import("./sui/cdpm/read.ts").then(({ getPositionManager, isAgentAuthorized }) =>
            import("./sui/pool.ts").then(({ getPoolState }) =>
              Promise.all([
                getPositionManager(sub.pmId),
                getPoolState(cfg.poolProfile.poolId),
                priceFeed.getSpot(),
                priceFeed.getHistory(5 * 60 * 1000),
              ]).then(([pm, pool, spot, history]) => {
                return shadowRunner.runShadowTick({
                  pm,
                  pool,
                  spot,
                  history,
                  profile: cfg.poolProfile,
                });
              }).catch((err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err);
                log.warn("shadow: tick failed", { pmId: sub.pmId, error: msg });
              })
            )
          ).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn("shadow: import failed", { error: msg });
          });
        }
      }, cfg.rebalanceIntervalMs);

      stopShadowRunner = () => clearInterval(shadowHandle);

      log.info("liquidity-manager: shadow mode active — mlAgent decisions recorded without execution");
    }

    // Register feed stop on process exit.
    process.once("beforeExit", stopFeeds);
  }

  // 8. Create and start the rebalancer.
  //    When shadow mode is active and strategy === "mlAgent", the live rebalancer
  //    runs the fallback (rule-based) strategy, not the mlAgent. This ensures
  //    live trading continues unchanged during the validation window.
  const executorService = createExecutorService();
  const rebalancerService = createRebalancerService(
    subscriptionsService,
    executorService,
    priceFeed,
    cfg.ml.shadowMode ? undefined : mlDeps,
  );
  const stopRebalancer = rebalancerService.start();

  // 9. Treasury (opt-in via TREASURY_ENABLED=true). Watcher polls every
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

  // 10. Graceful shutdown on SIGINT / SIGTERM.
  function shutdown(signal: string): void {
    log.info("received signal, shutting down", { signal });
    clearInterval(subHandle);
    stopRebalancer();
    stopShadowRunner?.();
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
