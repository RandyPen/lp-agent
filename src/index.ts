import { loadConfig } from "./config.ts";
import { openDb, getDb } from "./db/client.ts";
import { getAgentAddress } from "./sui/keypair.ts";
import { createOnchainPriceFeed } from "./data/feeds/onchain.ts";
import { createBinancePriceFeed } from "./data/feeds/binance.ts";
import type { PriceFeed } from "./data/priceFeed.ts";
import { createSubscriptionsService } from "./services/subscriptions.ts";
import { createExecutorService } from "./services/executor.ts";
import { createRebalancerService, reconcileOrphanedRebalances } from "./services/rebalancer.ts";
import { startTreasuryService, type TreasuryService } from "./services/treasuryService.ts";
import { createMarketAggregator } from "./data/marketAggregator.ts";
import { createBinanceMultiFeed } from "./data/feeds/binanceMulti.ts";
import { createDerivativesFeed } from "./data/feeds/derivatives.ts";
import { createCetusEventsFeed } from "./data/feeds/cetusEvents.ts";
import { createRiskMonitor } from "./risk/monitor.ts";
import { createRiskObserver } from "./services/riskObserver.ts";
import { log } from "./lib/logger.ts";

// ML / shadow mode imports — only used when STRATEGY=mlAgent or ML_SHADOW_MODE=true.
import type { MlAgentDeps, StrategyName } from "./strategies/registry.ts";

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

  // 7a. Market data + risk layer — UNCONDITIONAL for the live process.
  //
  // The risk circuits are the product: they must protect every live strategy,
  // not only mlAgent. The aggregator feeds (Binance/derivatives/Cetus) are the
  // price of that protection and run on rule-only deployments too.
  const db = getDb();

  // 7a-pre. Startup reconciliation sweep (Fix: crashes between the treasury
  // pre-charge and PTB submission previously stranded a debited charge with
  // the `rebalances` row stuck in 'planned' forever). MUST run before the
  // rebalance interval starts and before any tick fires in this process —
  // see reconcileOrphanedRebalances' doc comment for why that makes every
  // non-terminal row found here safe to sweep.
  const reconciliation = reconcileOrphanedRebalances(db);
  if (reconciliation.scanned > 0) {
    log.warn("liquidity-manager: startup reconciliation swept orphaned rebalances", reconciliation);
  }

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
  const stopFeeds: () => void = marketAggregator.start();

  // Live risk monitor — construction also rehydrates the L3 emergency-stop
  // latch from the DB (an unresolved trip survives restarts).
  const riskMonitor = createRiskMonitor({
    db,
    thresholds: cfg.risk.thresholds,
    l3: cfg.risk.l3,
  });

  // PnL accounting (D1): NAV sampling + fee/cost/IL attribution. Its
  // get24hPnlPct closes the daily-loss circuits (L2 pnl_24h + L3
  // catastrophic) — fed to the risk observer below and to mlAgent's deps.
  const { createPnlService } = await import("./services/pnlService.ts");
  const pnlService = createPnlService({ db, profile: cfg.poolProfile });
  const get24hPnlPct: ((poolId: string) => number | null) | undefined =
    pnlService.get24hPnlPct;

  // 7a-post. Risk observer background loop (G1 fix).
  //
  // L2 rolling-window circuits (checkVolatility5m, checkTvlDrop5m,
  // checkSpreadSustained) need ~30 s samples to build their 5-min windows,
  // and the per-source staleness feed must keep flowing even during a data
  // outage. The observer is restarted below if a shadow monitor is created.
  let stopRiskObserver: () => void = createRiskObserver({
    poolId: cfg.poolProfile.poolId,
    marketAggregator,
    riskMonitor,
    intervalMs: cfg.riskObserverIntervalMs,
    get24hPnlPct,
  }).start();

  // 7b. Decide whether we need the ML dependency graph.
  //
  // We build ML deps when:
  //   (a) STRATEGY=mlAgent — live ML inference
  //   (b) ML_SHADOW_MODE=true — shadow runner observes what mlAgent WOULD do
  //       (this applies even when the live strategy is a rule-based strategy)
  const needsMlGraph = cfg.strategy === "mlAgent" || cfg.ml.shadowMode;

  let mlDeps: MlAgentDeps | undefined;
  let stopShadowRunner: (() => void) | null = null;

  if (needsMlGraph) {
    const { createStateMachine } = await import("./state/machine.ts");
    const { buildStrategy } = await import("./strategies/registry.ts");

    // Live state machine — used by the mlAgent live path.
    const stateMachine = createStateMachine({
      poolId: cfg.poolProfile.poolId,
      db,
      params: cfg.stateParams,
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
      get24hPnlPct,
    };

    log.info("liquidity-manager: ML graph wired up", {
      sidecarUrl: cfg.prediction.sidecarUrl,
      fallbackStrategy: cfg.fallbackStrategy,
      liveStrategy: cfg.strategy,
      shadowMode: cfg.ml.shadowMode,
    });

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
        params: cfg.stateParams,
      });

      // DEDICATED shadow risk monitor — shadow ticks must not persist risk_events
      // that would interfere with live risk tracking. A separate monitor instance
      // writes to the same risk_events table but is scoped to shadow state only.
      // Shadow entries are distinguishable by the pool_id/pm_id + timestamp
      // correlation with shadow_decisions rows.
      // Share the LIVE emergency stop: L3 is process-wide (a tripped latch
      // must halt everything), and a second createEmergencyStop would
      // double-rehydrate from the same risk_events rows.
      const shadowRiskMonitor = createRiskMonitor({
        db,
        thresholds: cfg.risk.thresholds,
        l3: cfg.risk.l3,
        emergencyStop: riskMonitor.emergencyStop,
        source: "shadow",
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
      // The observer started in 7a-post feeds only the live monitor; now that
      // the shadow monitor exists, rebuild with both wired in.
      stopRiskObserver();
      stopRiskObserver = createRiskObserver({
        poolId: cfg.poolProfile.poolId,
        marketAggregator,
        riskMonitor,
        shadowRiskMonitor,
        intervalMs: cfg.riskObserverIntervalMs,
        get24hPnlPct,
      }).start();
    }
  }

  // 8. Create and start the rebalancer.
  //
  // Live strategy resolution: when shadow mode is active and STRATEGY=mlAgent,
  // the live rebalancer runs the FALLBACK (rule-based) strategy — live trading
  // continues unchanged during the validation window. (Passing mlAgent without
  // mlDeps used to crash at startup here; resolving the name explicitly fixes
  // that.) The risk monitor is threaded unconditionally — rule strategies get
  // their pre-tick veto from the rebalancer itself.
  const liveStrategyName: StrategyName =
    cfg.ml.shadowMode && cfg.strategy === "mlAgent" ? cfg.fallbackStrategy : cfg.strategy;
  if (liveStrategyName !== cfg.strategy) {
    log.info("liquidity-manager: shadow mode — live rebalancer runs the fallback strategy", {
      configured: cfg.strategy,
      live: liveStrategyName,
    });
  }
  const executorService = createExecutorService();
  const rebalancerService = createRebalancerService(
    subscriptionsService,
    executorService,
    priceFeed,
    {
      riskMonitor,
      liveStrategyName,
      mlDeps: liveStrategyName === "mlAgent" ? mlDeps : undefined,
      pnlService,
    },
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

  // 9b. Shadow fleet (opt-in via SHADOW_FLEET=name,name): rule strategies on
  // hypothetical books judged by real SwapEvents. Observability only — never
  // touches the executor. See src/services/shadowFleet.ts.
  let stopShadowFleet: (() => void) | null = null;
  if (cfg.shadowFleet.strategies.length > 0) {
    try {
      const { createShadowFleet } = await import("./services/shadowFleet.ts");
      const { getDb } = await import("./db/client.ts");
      stopShadowFleet = createShadowFleet({
        db: getDb(),
        profile: cfg.poolProfile,
        priceFeed,
        strategies: cfg.shadowFleet.strategies,
        initialA: cfg.shadowFleet.initialA,
        initialB: cfg.shadowFleet.initialB,
      }).start();
      log.info("liquidity-manager: shadow fleet started", {
        strategies: cfg.shadowFleet.strategies,
      });
    } catch (err: unknown) {
      // Shadow observability must never block the live agent.
      log.error("shadowFleet: failed to start (continuing without it)", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info("liquidity-manager running");

  // 10. Graceful shutdown on SIGINT / SIGTERM / uncaughtException.
  //
  // F3 fix: stopFeeds is called inside teardown() before process.exit().
  // Previously it was registered on `process.once("beforeExit")` which is
  // skipped when process.exit() is called directly — feeds were never stopped.
  //
  // Fix 4: `gracefulTeardown` is idempotent (the `shuttingDown` latch) so a
  // second SIGTERM (or an uncaughtException firing mid-shutdown) never
  // re-enters teardown. After stopping every interval — including the
  // rebalancer's own, via `stopRebalancer()` — it awaits
  // `rebalancerService.drain()` (bounded by DRAIN_TIMEOUT_MS) so an
  // in-flight tick that's awaiting on-chain confirmation is not abandoned
  // mid-PTB-submission by a synchronous process.exit().
  let shuttingDown = false;
  const DRAIN_TIMEOUT_MS = 30_000;

  async function gracefulTeardown(reason: string): Promise<void> {
    if (shuttingDown) {
      log.warn("liquidity-manager: teardown already in progress, ignoring repeat trigger", { reason });
      return;
    }
    shuttingDown = true;
    log.info("liquidity-manager: shutting down", { reason });
    clearInterval(subHandle);
    stopFeeds();
    stopRiskObserver();
    stopRebalancer();
    stopShadowRunner?.();
    stopShadowFleet?.();
    treasuryService?.stop();

    const drained = await Promise.race([
      rebalancerService.drain().then(() => true as const),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), DRAIN_TIMEOUT_MS)),
    ]);
    if (drained) {
      log.info("liquidity-manager: in-flight rebalancer ticks drained cleanly");
    } else {
      log.error(
        "liquidity-manager: shutdown drain timed out — in-flight rebalancer ticks may still be running",
        { timeoutMs: DRAIN_TIMEOUT_MS },
      );
    }
    log.info("liquidity-manager: shutdown teardown complete");
  }

  process.once("SIGINT", () => {
    gracefulTeardown("SIGINT").finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    gracefulTeardown("SIGTERM").finally(() => process.exit(0));
  });

  // A custody agent must never silently continue on undefined state. Both
  // handlers log the full stack; uncaughtException additionally attempts the
  // same graceful shutdown (bounded drain) before exiting non-zero — Node/Bun
  // semantics already consider the process state undefined at this point, so
  // teardown is best-effort, not a guarantee.
  process.on("unhandledRejection", (reason: unknown) => {
    log.error("liquidity-manager: unhandled promise rejection", {
      error: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
    });
  });

  process.on("uncaughtException", (err: unknown) => {
    log.error("liquidity-manager: uncaught exception — attempting graceful shutdown", {
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    });
    gracefulTeardown("uncaughtException").finally(() => process.exit(1));
  });
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  log.error("liquidity-manager fatal error", { error: msg });
  process.exit(1);
});
