/**
 * Example fork configuration.  cp agent.config.example.ts agent.config.ts
 *
 * Register YOUR strategies, pools, feeds and models here. The framework never
 * writes to this file or to `user/`, so you can pull upstream forever without a
 * merge conflict — which is not true if you edit src/strategies/registry.ts.
 * Commit both to your fork; they are not gitignored.
 *
 * Loaded before config is read, so the names below are valid STRATEGY /
 * POOL_PROFILE / PRICE_FEED values. If this file throws, the agent refuses to
 * start — it never quietly falls back to a strategy you did not configure.
 */

import { defineAgent } from "./src/kit/defineAgent.ts";
import { createExampleStrategy } from "./user/exampleStrategy.ts";

export default defineAgent({
  // Registered under `strategy.name`. Select with STRATEGY=example.
  //
  // Pass a FACTORY, not an instance: the live rebalancer, the shadow fleet and
  // the backtest each build their own strategy, and sharing one object would
  // leak state between PMs and between the live and shadow books.
  strategies: [() => createExampleStrategy()],

  // Select with POOL_PROFILE=<name>. `build` is lazy so env vars resolve on load.
  //
  // ⚠️  On any pool that is not SUI/USDC, run `bun run probe-bin-orientation`
  //     first and set `poolCoinAIsQuote` from what it reports. Guessing puts
  //     every bin on the wrong side of the market.
  // pools: [{ name: "eth-usdc", build: () => buildEthUsdcProfile() }],

  // Keyed by the name PRICE_FEED selects. Built-ins: onchain, binance.
  // feeds: { pyth: (profile) => createPythPriceFeed(profile) },

  // The model behind `mlAgent` — implement PredictionProvider and put anything
  // behind it. Overrides PREDICTION_PROVIDER.
  // prediction: () => createMyPredictionProvider(),
});
