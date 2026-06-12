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

// ML / shadow mode imports — only used when STRATEGY=mlAgent or ML_SHADOW_MODE=true.
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

  // 7a. Decide whether we need the ML dependency graph.
  //
  // We build ML deps when:
  //   (a) STRATEGY=mlAgent — live ML inference
  //   (b) ML_SHADOW_MODE=true — shadow runner observes what mlAgent WOULD do
  //       (this applies even when the live strategy is a rule-based strategy)
  //
  // Feeds are NOT started when neither (a) nor (b) is true.
  const needsMlGraph = cfg.strategy === "mlAgent" || cfg.ml.shadowMode;

  let mlDeps: MlAgentDeps | undefined;
  let stopFeeds: (() => void) | null = null;
  let stopRiskObserver: (() => void) | null = null;
  let stopShadowRunner: (() => void) | null = null;

  if (needsMlGraph) {
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
    const cetusFeed = createCetusEventsFeed({
      poolId: cfg.poolProfile.poolId,
      poolCoinADecimals: cfg.poolProfile.poolCoinADecimals,
      poolCoinBDecimals: cfg.poolProfile.poolCoinBDecimals,
    });

    const marketAggregator = createMarketAggregator({
      binance: binanceFeed,
      derivatives: derivFeed,
      cetus: cetusFeed,
    });

    // Start the feeds (returns a composite stop function).
    // Hoisted to stopFeeds so shutdown() can call it directly (F3 fix).
    stopFeeds = marketAggregator.start();

    // Live state machine and risk monitor — used by the mlAgent live path.
    const stateMachine = createStateMachine({
      poolId: cfg.poolProfile.poolId,
      db,
    });

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

    log.info("liquidity-manager: ML graph wired up", {
      sidecarUrl: cfg.prediction.sidecarUrl,
      fallbackStrategy: cfg.fallbackStrategy,
      liveStrategy: cfg.strategy,
      shadowMode: cfg.ml.shadowMode,
    });

    // 7b-pre. Start the risk observer background loop (G1 fix).
    //
    // L2 rolling-window circuits (checkVolatility5m, checkTvlDrop5m,
    // checkSpreadSustained) need ~30 s samples to build their 5-min windows.
    // Without this loop the windows are only populated when mlAgent.plan()
    // fires — every 20 min in NORMAL state — which starves the circuits.
    //
    // The shadow risk monitor is wired in below after the shadow runner is
    // built, so we start the observer here with only the live monitor and
    // re-create it with the shadow monitor once available.
    {
      const { createRiskObserver } = await import("./services/riskObserver.ts");
      const riskObserver = createRiskObserver({
        poolId: cfg.poolProfile.poolId,
        marketAggregator,
        riskMonitor,
        intervalMs: cfg.riskObserverIntervalMs,
      });
      stopRiskObserver = riskObserver.start();
    }

    // 7b. Shadow runner — built when ML_SHADOW_MODE=true, regardless of live strategy.
    //
    // Uses a DEDICATED state machine and risk monitor (F1 fix: sharing the live
    // machine would advance it N× per tick, one per managed PM, making shadow
    // data order-dependent garbage).
    //
    // DUPLICATION NOTE: when STRATEGY=mlAgent AND ML_SHADOW_MODE=true, both the
    // live mlAgent and the shadow runner write `predictions` rows for the same
    // pool. Shadow rows use model_version="shadow:mlAgent" to stay distinguishable.
    if (cfg.ml.shadowMode) {
      if (cfg.strategy === "mlAgent") {
        log.warn(
          "liquidity-manager: STRATEGY=mlAgent AND ML_SHADOW_MODE=true are both active. " +
          "Both the live mlAgent and the shadow runner will write predictions rows for pool " +
          cfg.poolProfile.poolId + ". Shadow rows use model_version='shadow:mlAgent'. " +
          "This is valid for comparison but doubles write volume — disable one if not needed.",
        );
      } else {
        log.info(
          "liquidity-manager: shadow mode active with rule-based live strategy. " +
          "Live strategy: " + cfg.strategy + ". Shadow: mlAgent (records without execution).",
        );
      }

      const { createShadowRunner } = await import("./services/shadowRunner.ts");
      const { createMlAgentStrategy } = await import("./strategies/mlAgent.ts");

      // DEDICATED shadow state machine — never shared with the live path.
      const shadowStateMachine = createStateMachine({
        poolId: cfg.poolProfile.poolId,
        db,
      });

      // DEDICATED shadow risk monitor — shadow ticks must not persist risk_events
      // that would interfere with live risk tracking. A separate monitor instance
      // writes to the same risk_events table but is scoped to shadow state only.
      // Shadow entries are distinguishable by the pool_id/pm_id + timestamp
      // correlation with shadow_decisions rows.
      const shadowRiskMonitor = createRiskMonitor({
        db,
        thresholds: cfg.risk.thresholds,
      });

      // Shadow mlAgent uses the shadow-dedicated deps.
      const shadowMlDeps: MlAgentDeps = {
        provider: mlDeps.provider,   // share the prediction provider (read-only)
        stateMachine: shadowStateMachine,
        riskMonitor: shadowRiskMonitor,
        marketAggregator: mlDeps.marketAggregator,   // share feeds (read-only)
        fallback: buildStrategy(cfg.fallbackStrategy),
        db,
      };

      const mlStrategy = createMlAgentStrategy(shadowMlDeps);
      const ruleStrategyForShadow = buildStrategy(cfg.fallbackStrategy);
      const shadowRunner = createShadowRunner({
        mlStrategy,
        ruleStrategy: ruleStrategyForShadow,
        stateMachine: shadowStateMachine,
        db,
        strategyLabel: "shadow:mlAgent",
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

      // Restart the risk observer so it also feeds the shadow risk monitor.
      // The observer started in 7b-pre feeds only the live monitor; now that
      // the shadow monitor exists, rebuild with both wired in.
      stopRiskObserver?.();
      {
        const { createRiskObserver } = await import("./services/riskObserver.ts");
        const riskObserver = createRiskObserver({
          poolId: cfg.poolProfile.poolId,
          marketAggregator,
          riskMonitor,
          shadowRiskMonitor,
          intervalMs: cfg.riskObserverIntervalMs,
        });
        stopRiskObserver = riskObserver.start();
      }
    }
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
      treasuryService = startTreasuryService(cfg);
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
  //
  // F3 fix: stopFeeds is called inside shutdown() before process.exit(0).
  // Previously it was registered on `process.once("beforeExit")` which is
  // skipped when process.exit() is called directly — feeds were never stopped.
  function shutdown(signal: string): void {
    log.info("received signal, shutting down", { signal });
    clearInterval(subHandle);
    stopFeeds?.();
    stopRiskObserver?.();
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
