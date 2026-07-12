# LP Agent

> An **open-source framework for non-custodial LP agents on Sui** — a reference implementation you fork and run yourself, not a hosted app. It **scaffolds the whole agent** — the Move custody boundary, L1/L2/L3 risk breakers, atomic multi-protocol execution, idle-asset lending, and a ready-to-ship user portal — so you bring one thing: **the strategy**. The reference agent forecasts short-term **volatility** (not price direction) and shapes Cetus DLMM liquidity as a vol-scaled band around the market — earning swap fees, capturing buy-low/sell-high spread, and parking idle capital in lending — all while running **inside a Move permission boundary that makes withdrawal impossible**. The user keeps custody; the agent can touch the position, never the exit.

It plugs into [LeafSheep](https://app.leafsheep.xyz)'s `PositionManager` delegation slot, auto-discovers work from on-chain `AgentAdded` events, and submits each rebalance as one atomic PTB. There is no central service: each deployer owns their own risk policy, capital limits, fee design, and trained model. The design thesis is laid out in the essay *"Market Making Is a Forecasting Problem: The Design of an Open-Source LP Agent for Sui"* — LP is a forecasting problem, and σ matters more than μ **literally**: walk-forward analysis falsified our own price-direction predictor (the q50 center placed no better than spot), so we removed it and kept only the volatility head, placing liquidity as a σ-scaled band centered on spot. Directional posture is handled by rule-based regime gates, not a trained center head — the burden of proof to reintroduce one is documented in `docs/decision-remove-center-prediction.md`.

Bun + TypeScript + SQLite (agent) · uv + Python, LightGBM (ML pipeline). ~18K LOC, 900+ bun tests + ~100 pytest tests, Apache-2.0.

**v1 has landed**: the ML prediction pipeline lives in-tree — a Python training + inference sidecar (`ml/`, managed with uv; **vol-only by design** — the mean-price head was falsified by walk-forward and removed, see `docs/decision-remove-center-prediction.md`), the `mlAgent` strategy, a three-state machine (`src/state`), layered circuit-breaker risk controls (`src/risk`), and shadow mode (`src/services/shadowRunner`). **The repo ships the pipeline and the framework, not trained models** — model artifacts stay out of git; forks retrain on the same pipeline. Bring your own strategies, your own pools, your own models.

## What it does

- **Algorithmic rebalancing** — five registered strategies, each rebalance submitted as one atomic PTB:
  - **`presenceAnchor` / `presenceSweep`** (mainline, under forward shadow A/B) — regime-gated market *presence*: NORMAL/TREND/DEFENSE nowcast from realized vol-ratio + drift, σ-scaled width, a clamped 4h-anchor reversion tilt, and withdraw-only defense (the agent has no taker permission — leaving the market IS the defense). `presenceSweep` adds the anchor-boundary flip-sweep / freeze discipline.
  - **`multiBinSpot`** (Tier 0) — rule-based log-normal distribution placement; the explicit fallback whenever the ML sidecar is degraded. **`singleBin`** — simplest reference baseline.
  - **`mlAgent`** — consumes the vol model through `PredictionProvider` (σ width + range-break probabilities; the range always centers on the active bin — no direction is predicted, by evidence, not by omission).
  - (`emaTrend` was **removed**: its premise — predictable short-horizon direction — measured at coin-flip accuracy in walk-forward and out-of-sample, and its trend-biased placement is a directional bet the evidence says nobody should take. `docs/decision-remove-center-prediction.md` records the falsification; recover the code from git history if you want a directional-strategy skeleton.)
- **Idle-asset lending** — Scallop + Kai SAV integration, APY-aware router (25 bps Scallop tie-break), per-coin dust thresholds.
- **Multi-source price feeds** — on-chain Cetus `SwapEvent` and Binance REST implementations behind one `PriceFeed` interface, sharing a `price_observations` history table.
- **Automatic PM discovery** — the agent address is derived from `MNEMONICS`, the agent listens for on-chain `AgentAdded` events and adds the `PositionManager` to its monitor; `AgentRemoved` / `PositionManagerClosed` remove it automatically.
- **User top-up accounting** — per-user derived deposit addresses, a SQLite credit ledger, a periodic watcher that credits inbound deposits, APY-aware conversion rates. Deposit addresses typically hold only stablecoins; operator sweep (`treasury-sweep.ts`) and refund (`treasury-refund.ts`) use Sui's protocol-level gasless stablecoin transfers (mainnet, 2026-05-20) for USDC and the other six allowlisted coins — the deposit address needs zero SUI for gas. The watcher merges coin-object balances and address-balance accumulator balances (from gasless deposits) into a single observed total, so both deposit paths are credited correctly. Non-allowlisted coins and the explicit `--force-gas` flag fall back to the legacy coin-object path.
- **CDPM permission boundary** — all operations go through the LeafSheep `PositionManager`; user funds never leave the user's own vault.

## The hard ceiling: no swap, so inventory is not a control variable

Read this before you plan a strategy — it is a **permission-layer** limit, not a
missing feature, and no amount of forking removes it.

The CDPM custody boundary grants the agent exactly five powers: add liquidity,
remove liquidity, collect fees, collect rewards, move the fee bag into the
balance. **There is no swap.** The agent is a pure maker; it has no taker
permission, by construction — that is the same property that makes it unable to
steal, so it is not going away.

The consequence is easy to miss: **your strategy cannot change the PM's asset
ratio.** After a directional move leaves a position 90 % base / 10 % quote, you
can re-place that skewed inventory across bins, or park the excess in lending —
but you cannot sell base for quote to get back to 50/50. So:

- ✅ Buildable: range/width selection, regime gating, recentering policy,
  bin-weight distribution, fee-harvest timing, when to leave the market entirely
  (withdraw-only defense), how much to lend.
- ❌ Not buildable here: delta-neutral or inventory-targeting strategies, hedging,
  anything whose control loop is "swap to restore a target ratio." Those need a
  taker venue, which means a different custody design.

Directional exposure is managed by *where you place and whether you're present* —
never by trading. If your idea needs a swap, this framework is the wrong base.

## What it does **not** do (deliberately left to forks)

- ❌ No trained models — the ML pipeline is in-tree (`ml/`), but the model artifacts (the alpha) are yours to train
- ❌ No LLM signal layer / news ingestion — future external signals plug in via a `PredictionProvider` decorator or inside the sidecar, never as framework changes
- ❌ No cross-chain support (Sui mainnet only)
- ❌ No public HTTP API — SQLite + CLI scripts only, plus an optional bind-local treasury HTTP API (`TREASURY_HTTP_ENABLED`, off by default; never expose it raw to the internet)
- ❌ No user-initiated refunds (operator sweeps manually)
- ❌ **One pool per process** — `POOL_PROFILE` is process-global, and a PM whitelisted on any other pool is skipped with a warning. Multi-pool = multiple processes.
- ❌ **No per-user risk limits** — `RISK_*` thresholds are process-global, and the L3 emergency stop is a single latch for the whole fleet.

## Architecture

The chain is the control plane: users delegate a `PositionManager` on-chain, the agent auto-discovers it, and every decision leaves as **one atomic PTB** that can touch the position but never withdraw from it.

```mermaid
flowchart TB
    subgraph chain["⛓️ Sui mainnet — the custody boundary"]
        PM["User's PositionManager (CDPM)<br/>— owner keeps custody —<br/>agent may: add · remove · collect<br/><b>agent may NOT: withdraw · close · swap</b>"]
        POOL["Cetus DLMM pool"]
        LEND["Scallop / Kai lending"]
    end

    PM -- "AgentAdded / AgentRemoved events" --> SUB

    subgraph agent["🤖 LP Agent · Bun + TypeScript"]
        SUB["Subscription service<br/>auto-discovers delegated PMs"] --> REB["Rebalancer<br/>per-PM tick loop"]
        FEEDS["Market-data feeds<br/>onchain · Binance · derivatives"] --> AGG["Market aggregator"]
        AGG --> REB
        REB --> RISK{"Risk gate<br/>L1 / L2 / L3"}
        RISK -- "L3 emergency → halt, no new tx" --> HALT(["🛑 latched<br/>until human reset"])
        RISK -- "L2 extreme → bypass strategy,<br/>force full withdrawal" --> EXEC
        RISK -- "L1 soft / clear" --> STATE["State machine<br/>NORMAL · TREND · EXTREME"]
        STATE --> STRAT["🔌 Strategy slot<br/><i>built-in or fork-registered</i>"]
        AGG --> FC["Forecast layer · rule-based<br/>σ + bin weights (Tier 0)"]
        FC -- "rule-based forecast" --> STRAT
        STRAT -- "RebalancePlan" --> EXEC["Executor<br/>builds ONE atomic PTB"]
        REB -. "optional billing" .-> TRE["Treasury<br/>credit ledger · pre-debit / refund"]
    end

    subgraph ml["🐍 Prediction · behind the PredictionProvider seam"]
        PRED["🔌 PredictionProvider"] --> LGBM["LightGBM vol model<br/>σ + range-break probs<br/><i>(Python sidecar, ml/)</i>"]
        PRED --> NULLP["NullProvider<br/><i>rule-based, no Python</i>"]
    end

    AGG -- "MarketSnapshot" --> PRED
    PRED -- "σ + p_break (mlAgent only)" --> STRAT
    PRED -. "degraded → explicit Tier 0 fallback" .-> FC

    EXEC -- "collect → remove → transfer → redeem → add → supply" --> PM
    PM --- POOL
    PM --- LEND
    FEEDS -. "reads swap events" .- POOL
```

**Legend — each box maps to a module** (`ID` is the diagram node id):

| Box | ID | Source |
|---|---|---|
| Subscription service | `SUB` | `src/services/subscriptions.ts` — **filters to one pool**; a PM on any other pool is skipped |
| Rebalancer (tick loop) | `REB` | `src/services/rebalancer.ts` |
| Market-data feeds | `FEEDS` | `src/data/feeds/` (onchain · binance · binanceMulti · derivatives · cetusEvents) |
| Market aggregator | `AGG` | `src/data/marketAggregator.ts` |
| Risk gate L1/L2/L3 | `RISK` · `HALT` | `src/risk/` — L1 soft-adjusts, **L2 forces a full withdrawal (bypassing the strategy)**, L3 latches and halts |
| State machine | `STATE` | `src/state/` |
| **Strategy slot** | `STRAT` | `src/strategies/` (built-ins) + anything a fork registers — see the seam diagram below |
| Forecast layer (rule-based, Tier 0) | `FC` | `src/forecast/` (σ estimators + bin-weight mapping) |
| Executor (atomic PTB) | `EXEC` | `src/services/executor.ts` |
| Treasury (billing) | `TRE` | `src/treasury/` |
| **PredictionProvider seam** | `PRED` | `src/prediction/` — `PREDICTION_PROVIDER=sidecar\|null` |
| LightGBM vol model / Null provider | `LGBM` · `NULLP` | `ml/` (Python, uv) — **vol-only by design**; the center head was falsified and removed (`docs/decision-remove-center-prediction.md`). `NULLP` runs the same graph with no Python. |
| PositionManager / pool / lending | `PM` · `POOL` · `LEND` | on-chain: CDPM PositionManager, Cetus DLMM pool, Scallop/Kai (adapters in `src/sui/lending/`) |

**One tick, per subscribed PM:** fetch PM state + pool active bin + spot + history → pre-tick **risk** check → **state** machine eval → **strategy** plan (consuming the ML prediction or the rule-based **forecast** layer) → lending router decides redeem/supply → (optional) **treasury** pre-debit → **executor** submits the unified PTB → on failure refund the charge → record to SQLite. If the prediction provider is unavailable the agent degrades **explicitly** to Tier 0 and logs the reason — never a silent fallback.

Two things the diagram is deliberately honest about: the risk gate can **bypass your strategy entirely** (an L2 EXTREME issues a forced full withdrawal without calling `plan()`), and an **L3 trip latches** — it stops submitting transactions and survives restarts until a human runs `bun run risk-reset`. It halts; it does not unwind.

### The fork seam — what you plug in, and where

Everything marked 🔌 above is a slot. You fill it from `agent.config.ts`, and the
framework's own source is never edited — which is what makes upstream pulls
conflict-free:

```mermaid
flowchart LR
    subgraph fork["📦 YOUR fork — upstream never writes to these paths"]
        USR["user/<br/>your strategy · pool · feed · model"]
        CFG["agent.config.ts<br/><b>defineAgent({ … })</b>"]
        USR --> CFG
    end

    subgraph reg["🔌 Registries — resolved at startup, before config"]
        RS["Strategy registry<br/>selected by STRATEGY"]
        RP["Pool registry<br/>selected by POOL_PROFILE"]
        RF["Price-feed registry<br/>selected by PRICE_FEED"]
        RM["Prediction provider<br/>selected by PREDICTION_PROVIDER"]
    end

    CFG -- "strategies" --> RS
    CFG -- "pools" --> RP
    CFG -- "feeds" --> RF
    CFG -- "prediction" --> RM

    RS --> RUN["Agent runtime · src/<br/><b>you never edit this</b>"]
    RP --> RUN
    RF --> RUN
    RM --> RUN
```

| Slot | You write | Registry |
|---|---|---|
| Strategy | `strategies: [() => createMine()]` — a **factory**, not an instance | `src/strategies/registry.ts` |
| Pool profile | `pools: [{ name, build }]` | `src/pools/index.ts` |
| Price feed | `feeds: { pyth: (profile) => … }` | `src/data/feedRegistry.ts` |
| Prediction model | `prediction: () => createMyProvider()` | wired in `src/index.ts` |

Factories, not instances: the live rebalancer, the shadow fleet and the backtest
each build their own strategy, so a shared object would leak state between PMs —
and between the live book and the shadow book that exists to validate it.

All four share one generic registry (`src/kit/registry.ts`) and are loaded by
`src/kit/loadExtensions.ts` **before** `loadConfig()` — so your names are valid
`STRATEGY` / `POOL_PROFILE` / `PRICE_FEED` values. No `agent.config.ts` = built-ins
only; a broken one **aborts startup** rather than silently falling back.

### Evaluating a strategy before it touches money

```mermaid
flowchart LR
    F["bun run seed-fixture<br/><i>committed CSV, offline</i>"] --> B
    C["bun run collect-historical<br/><i>public Binance klines</i>"] --> B
    B["bun run backtest<br/><b>decision trace</b><br/>no fees · no IL · no gas"] --> S
    S["bun run shadow<br/><b>real fills</b> from on-chain SwapEvents<br/>hypothetical book · zero capital"] --> L["bun start<br/>funded PositionManager"]
```

The backtest tells you *what your strategy would do*; only shadow tells you *how it
would have done*. Neither needs a key.

> The repo ships the framework and the pipeline drawn above — **not** the trained model that sits behind the `PredictionProvider` seam. Forks train their own. See [`docs/project-overview.md`](./docs/project-overview.md) for the module-level map.

## Try it in 5 minutes (no keys, no wallet, no chain writes)

You do **not** need a mnemonic, a funded address, or a `PositionManager` to see
a strategy run. Two credential-free loops ship in the box:

```bash
bun install

# A. Replay a strategy over real history — offline, no network at all.
#    Seeds from a committed fixture (1 day of 1m SUI/USDC closes).
bun run seed-fixture
bun run backtest --pool-id=binance:SUIUSDC --strategy=presenceAnchor

# B. Run strategies against the LIVE market on a hypothetical book.
#    Fills a simulated position from real on-chain SwapEvents and never signs
#    anything. Needs a pool id, no secrets.
SUI_USDC_POOL_ID=0x<dlmm-pool> bun run shadow
```

For real, current, longer history use `bun run collect-historical` (public
Binance klines) instead of the fixture.

> **Region note:** `api.binance.com` is geo-blocked in some jurisdictions (incl.
> the US), which affects `collect-historical` and the `binance` price feed. The
> fixture path above needs no network; for live use, point `BINANCE_BASE_URL` at
> a reachable mirror, or run with `PRICE_FEED=onchain` (Cetus `SwapEvent`), which
> has no such dependency.

`backtest` is a **decision trace** (trigger frequency, bins touched) — it has no
fee/IL/gas accounting, so don't rank strategies by return with it. `shadow` is
the honest evaluator: real fills, real market, zero capital at risk. Score a run
with `bun run shadow-report`.

## Quick start (live, on mainnet)

```bash
# 1. Install
bun install                              # aftermath override pinned to 2.0.1

# 2. Configure (.env file)
cp .env.example .env                     # edit in your secrets
                                         # Required:
                                         #   - AGENT_MNEMONICS or AGENT_PRIVATE_KEY
                                         #   - EXPECTED_AGENT_ADDRESS (guards against the wrong mnemonic)
                                         #   - SUI_USDC_POOL_ID (mainnet pool id)
                                         # Missing fields are reported in one batch at startup.
                                         # ML / risk env vars (sidecar URL, shadow mode,
                                         # risk thresholds) are documented in .env.example.

# 3. Verify key derivation — the mnemonic must derive EXPECTED_AGENT_ADDRESS.
#    Probes the common Sui BIP44 paths and reports which matched. Never prints
#    key material. The runtime enforces the same match at startup.
bun run verify-agent

#    On a pool other than SUI/USDC, ALSO run this — it confirms on-chain which
#    side of the active bin holds which physical coin. Getting it backwards is
#    the most expensive bug in a DLMM agent; this repo shipped it once already.
bun run probe-bin-orientation

# 4. Static integrity
bun run typecheck && bun test
cd ml && uv sync && uv run pytest        # (optional) ML pipeline

# 5. Run
bun start
```

If the L3 emergency stop ever latches, it **survives restarts** — clear it with
`bun run risk-reset "<reason>"`, then restart. See `scripts/README.md` for the
full operator toolkit.

## Extension points (the core value of the framework)

Five clearly carved extension seams — each has a ready-made interface; one registration line or one new file is all it takes:

### 1. Add a strategy

A strategy is one file implementing the `Strategy` interface (`src/strategies/types.ts`). It is a **pure decision function**: given a market snapshot it returns *what to do*, and the framework owns everything else — risk gating, atomic PTB execution, lending of idle capital, custody boundary, journaling, shadow validation. **You write `plan()`; the framework provides the rest.**

**The interface** — three members, only `plan` is required:

```ts
export interface Strategy {
  readonly name: string;
  readonly historyWindowMs?: number;              // price history you need (default 5 min)
  plan(input: StrategyInput): Promise<StrategyOutput>;
}
```

**What `plan()` receives** (`StrategyInput`):

| Field | Type | What it is |
|---|---|---|
| `pm` | `PMState` | Your PM: `balance.{a,b}`, `feeBag.{a,b}`, `positionBins[]`, `lending`, `positionValue` — all **PHYSICAL** coin amounts (coinA/coinB as the pool holds them) |
| `pool` | `PoolState` | `activeBinId`, `binStep`, `feeRateBps` |
| `spot` | `PriceObservation` | Current quote price (coinB-per-coinA, decimal-adjusted) + timestamp |
| `history` | `PriceObservation[]` | Price history over `historyWindowMs`. **This is your feature source** — feed it to your own σ estimator, LLM client, external signal, anything |
| `profile` | `PoolProfile` | Pool metadata + orientation. Route every bin↔price decision through `src/domain/binMath.ts` (`humanPriceForBin` / `binDirection` / `orientationOf`) |

**What `plan()` returns** — one of four `StrategyOutput` kinds:

| Kind | Meaning |
|---|---|
| `{ kind: "plan_and_reconcile", plan }` | Execute the rebalance PTB **and** run lending reconciliation (cover shortfall + deploy idle). The normal path. |
| `{ kind: "plan_only", plan }` | Execute the rebalance, skip lending (tactical move, e.g. fee harvest) |
| `{ kind: "reconcile_only", reason }` | No rebalance — just capture idle yield / cover a shortfall |
| `{ kind: "quiet", reason }` | Do nothing this tick |

The `plan` you build is a `RebalancePlan` (`src/domain/types.ts`): `removeShares` (drained first), then `addBins[]` / `addAmountsA[]` / `addAmountsB[]` (placed second, same length), `collectFees`, and a free-form `reason` captured into the journal.

**Two contracts your `plan` must honor** (both verified on mainnet — see `CLAUDE.md` → *Load-bearing execution facts*):

- **Bin orientation** — bins **above** the active bin hold physical **coinA** only; bins **below** hold **coinB** only; **never place on the active bin** (composition-fee policy). Split your capital by side accordingly. Do not assume "bin up = price up" — the SUI/USDC pool is inverted; go through `binMath.ts`.
- **Sizing** — size `addAmounts*` from the **pre-remove** snapshot (`pm.balance` + fee bag when `collectFees` + `pm.positionValue`). The rebalancer re-scales your per-bin amounts to the actual post-remove balances, so you work in ratios, not realized amounts.

**Skeleton** (copy `multiBinSpot.ts` — 286 lines, zero ML deps — and replace only the distribution step with your alpha):

```ts
// src/strategies/myStrategy.ts
import type { Strategy, StrategyInput, StrategyOutput } from "./types.ts";
import { orientationOf } from "../domain/binMath.ts";

export function createMyStrategy(): Strategy {
  return {
    name: "myStrategy",
    historyWindowMs: 60 * 60 * 1000,             // e.g. 1h — omit for the 5-min default
    async plan(input: StrategyInput): Promise<StrategyOutput> {
      const { pm, pool, spot, history, profile } = input;

      // 0. Guard: empty PM / bad price → quiet
      if (pm.balance.a === 0n && pm.balance.b === 0n && pm.positionBins.length === 0)
        return { kind: "quiet", reason: "myStrategy: empty PM" };

      // 1. YOUR ALPHA: turn `history` (+ optional PredictionProvider, external
      //    signal, LLM call) into a target bin range + per-bin weights.
      const orientation = orientationOf(profile);
      // ... compute targetBins, weights ...

      // 2. Split capital by the physical-side rule (bins above active → coinA,
      //    below → coinB, active excluded); build addBins / addAmountsA / addAmountsB.

      // 3. Decide trigger (recenter? drift? fees-only?) and return:
      return {
        kind: "plan_and_reconcile",
        plan: {
          pmId: pm.pmId,
          removeShares: new Map(/* current bins → shares, to redeploy from scratch */),
          addAmountA: 0n, addAmountB: 0n,
          addBins: [], addAmountsA: [], addAmountsB: [],
          collectFees: pm.feeBag.a > 0n || pm.feeBag.b > 0n,
          reason: "myStrategy: recenter",
          plannedActiveBinId: pool.activeBinId,
        },
      };
    },
  };
}
```

**Register** — in `agent.config.ts`, a file the framework never writes to:

```ts
// agent.config.ts   (cp agent.config.example.ts agent.config.ts)
import { defineAgent } from "./src/kit/defineAgent.ts";
import { createMyStrategy } from "./user/myStrategy.ts";

export default defineAgent({
  strategies: [() => createMyStrategy()],   // a FACTORY, not an instance
});
```

Pass a factory, not an instance: the live rebalancer, the shadow fleet and the
backtest each build their own strategy. Sharing one object would leak state
between PMs — and between the live book and the shadow book that exists to
validate it.

That's it — **you never edit a file under `src/`.** Your strategy lives in
`user/`, your wiring lives in `agent.config.ts`, and both are yours. Because
upstream never touches those paths, you can `git pull` this framework forever
without a merge conflict. (They are *not* gitignored — commit them to your fork
like any other source.)

If `agent.config.ts` is absent you simply get the built-ins. If it's present but
broken, **startup fails loudly** — a custody agent must never quietly run a
different strategy than the one you configured.

**Run it**: `STRATEGY=myStrategy bun start`.

**Test it** — the kit is provided; you write ~5 lines:

```ts
import { makeInput, makeTestProfile, assertPlanInvariants } from "../tests/helpers/index.ts";

const out = await createMyStrategy().plan(makeInput({ activeBin: 1445 }));
assertPlanInvariants(out, makeTestProfile(), 1445);   // ← the important one
```

`assertPlanInvariants` runs the **same validator the rebalancer runs before it
submits on-chain** (`src/decision/planInvariants.ts`): bins above the active bin
carry physical coinA only, bins below carry coinB only, nothing lands on the
active bin, and the per-bin amounts sum to the declared totals. So a plan that
passes your test is a plan the live agent will accept — and if your strategy ever
emits an invalid one in production, **the agent refuses to submit it** rather than
placing a user's liquidity on the wrong side of the market. (This repo shipped
exactly that bug once, unnoticed. Hence the guard.)

The default `makeTestProfile()` is deliberately the **inverted** SUI/USDC shape,
where a higher bin id means a *lower* price — a strategy that only works on a
non-inverted pool has an orientation bug that a friendlier fixture would hide.

**Validate before you go live** — in escalating order of realism, none of which
costs you a cent:

1. `bun run typecheck && bun test`.
2. **Replay it offline** — no keys, no chain:
   `bun run seed-fixture && bun run backtest --pool-id=binance:SUIUSDC --strategy=myStrategy`.
   This is a *decision trace* (trigger frequency, bins touched); it has no
   fee/IL/gas accounting, so don't rank strategies by return with it.
3. **Shadow it against the live market** — real prices, real on-chain
   `SwapEvent` fills into a hypothetical book, **zero capital at risk**:
   `STRATEGY=myStrategy bun run shadow`, then score with `bun run shadow-report`.
4. Only then point a funded `PositionManager` at it.

References: `user/exampleStrategy.ts` (a complete worked example, written to be
edited) · `singleBin.ts` (109 lines, simplest built-in) · `multiBinSpot.ts`
(probability-distribution placement) · `presenceAnchor.ts` (regime-gated,
declares a 4h `historyWindowMs`).

### 2. Add a pool profile

A `PoolProfile` is **pure data** — ids, decimals, bin step, orientation, per-coin
lending knobs. Declare it in `agent.config.ts`; no framework file changes:

```ts
export default defineAgent({
  pools: [{ name: "eth-usdc", build: () => buildEthUsdcProfile() }],
});
```

Then `POOL_PROFILE=eth-usdc bun start`.

> ⚠️ **On any pool that is not SUI/USDC, run `bun run probe-bin-orientation` first**
> and set `poolCoinAIsQuote` from what it reports. "Bin id up" does **not** mean
> "price up" — the SUI/USDC pool is inverted. Guessing puts every bin on the
> wrong side of the market; this repo shipped that bug once already.

### 2b. Add a price feed

`PriceFeed` (`src/data/priceFeed.ts`) is a three-method interface. Register an
implementation under the name `PRICE_FEED` selects:

```ts
export default defineAgent({
  feeds: { pyth: (profile) => createPythPriceFeed(profile) },
});
```

Then `PRICE_FEED=pyth bun start`. Built-ins: `onchain` (Cetus `SwapEvent`) and
`binance` (public REST).

### 3. Add a lending protocol

Mirror `src/sui/lending/scallop.ts` as a new adapter, add a protocol branch to `pickHighestApy` in `src/sui/lending/router.ts`, and extend the `LendingProtocol` union in `src/sui/lending/types.ts`.

### 4. Add a lendable coin

Edit three lists in `src/sui/lending/lendingConfig.ts`:
- `LENDING_OPPORTUNITIES` — add the `(protocol, coin)` pair
- `MIN_LENDING_DELTA_RAW` — add the coin's dust threshold
- (Scallop path) `SCALLOP_RESERVES` — add the BalanceSheet reference
- (Kai path) `src/sui/lending/kaiVaults.ts` — add the vault metadata

No code changes, no schema changes, no service restart.

### 5. Swap the prediction model

```ts
// src/prediction/provider.ts — the single seam for replacing the model
export interface PredictionProvider {
  readonly name: string;
  predict(snapshot, ctx): Promise<PredictionResponse>;
  health(): Promise<ProviderHealth>;
}
```

Implement `PredictionProvider` and register it — the framework does not change:

```ts
export default defineAgent({
  prediction: () => createMyPredictionProvider(),
});
```

Two implementations ship: `sidecarProvider.ts` (HTTP → the Python sidecar) and
`nullProvider.ts` (deterministic, rule-based, **no Python and no network**).
Select between them with `PREDICTION_PROVIDER=sidecar|null` — so you can run the
whole ML decision graph, including `mlAgent`, on a machine with no sidecar:

```bash
STRATEGY=mlAgent PREDICTION_PROVIDER=null bun run shadow
```

The training pipeline lives in `ml/` (uv-managed, LightGBM vol model — quantile loss on the volatility head only; the center head was falsified and removed, see `docs/decision-remove-center-prediction.md`); forks rebuild the training set with the shipped collectors (`cd ml && uv run python -m data.collectors.binance_klines --start … --end …`) and train their own.

## What you bring

| You want to add | The framework provides | You do |
|---|---|---|
| LLM signal source | `Strategy.plan()` receives `history: PriceObservation[]` | Bring your own LLM client / RSS scraper / Twitter API and feed it into the decision inside your strategy |
| Cross-chain | (nothing) | Bring a bridge SDK and run it as a separate service outside the main process; do not pollute the treasury module |
| HTTP API | bind-local treasury API + read-only agent routes (`src/web/routes.ts`) | Extend `matchWebRoute` with new GET endpoints, or add mutating routes behind the existing signature-verification pattern |

## Web portal (`web/`)

A standalone user-facing site ships in `web/` — Vite + React 19 + `@mysten/dapp-kit-react` v2, dark quant-terminal UI. **It is part of the framework**: every operator who forks lp-agent self-hosts this portal for their own users — the front door where a user connects a wallet, enrolls a `PositionManager`, authorizes the operator's agent, tops up, and watches every rebalance on-chain. Fork it, rebrand it, or replace it — the agent only depends on the bind-local HTTP API, never on this UI. When the API serves the seeded demo dataset (`scripts/serve-demo-api.ts` sets `WEB_DEMO_MODE`), the portal shows a **"DEMO DATA"** banner so sample NAV / fees / rebalance figures are never mistaken for real performance. Its pages:

- **Enroll** — create a custody `PositionManager` + add liquidity (tx 1), then whitelist the agent operator (tx 2). The agent's `AgentAdded` watcher picks the PM up automatically; the wizard cross-checks that the portal and the running agent point at the same CDPM deployment before signing.
- **Dashboard** — NAV per PM, cumulative fee income, three-state timeline, live L1/L2/L3 risk events.
- **Intelligence** — observed price vs the model's ±1.28σ vol band (centered on spot — the pipeline deliberately predicts no price direction), model-vs-fallback share, shadow-mode ML-vs-rule comparison.
- **Positions** — per-PM rebalance history with full plan drill-down and explorer links.
- **Account** — signature-only registration, per-user deposit address, credit balance, deposit history.

```bash
# agent side: expose the API (bind-local) — TREASURY_HTTP_ENABLED=true bun start
cd web && bun install && bun run dev     # Vite proxies /v1 → 127.0.0.1:8378
```

The portal reads the agent's data only through the HTTP API (no direct SQLite access) and signs only user-owned CDPM calls (`user_deposit_liquidity`, `user_insert_agent`) through the connected wallet.

## Project structure

```
src/
├── index.ts                  # process entry point, starts all services
├── config.ts                 # env → AppConfig
├── domain/                   # cross-layer shared types + bin/fee math
├── pools/                    # pool profiles (sui-usdc as the example)
├── sui/                      # Sui chain interaction
│   ├── client.ts             # JSON-RPC client singleton
│   ├── pool.ts               # pool state reads
│   ├── keypairs/             # multi-role keys (agent + treasury)
│   ├── cdpm/                 # CDPM PTB builders (unified + legacy)
│   └── lending/              # lending integration (Scallop + Kai + router + math + config)
├── data/                     # price / market data feeds (onchain / binance / binanceMulti / derivatives / cetusEvents) + marketAggregator
├── forecast/                 # σ estimation (volatility.ts: EWMA/Parkinson/GK) + bin-weight mapping
├── prediction/               # PredictionProvider interface + sidecar / null implementations
├── state/                    # three-state machine (NORMAL / TREND / EXTREME)
├── risk/                     # layered circuit breakers (L1/L2/L3) + monitor + PnL attribution
├── decision/                 # diff planner / inventory / age stop-loss
├── strategies/               # strategy implementations + registry (incl. mlAgent)
├── treasury/                 # user top-ups + credit ledger + watcher + charges (+ bind-local HTTP API)
├── web/                      # read-only HTTP routes serving the web portal (mounted into the treasury API)
├── services/                 # orchestration (rebalancer / executor / subscriptions / treasuryService / shadowRunner)
├── db/                       # SQLite single-file schema (CREATE IF NOT EXISTS, no migrations)
├── lib/                      # utilities: logger / locks / errors
└── backtest/                 # offline strategy replay tooling

ml/                           # Python pipeline (uv-managed): data / features / training / serving / backtest / tests
                              # model artifacts in ml/artifacts/ stay out of git; uv.lock IS tracked for reproducibility

web/                          # user-facing portal (Vite + React + dapp-kit v2) — standalone package, own lockfile
```

## Documentation

- `README.md` (this file) — what the agent does, quick start, and the extension-point recipes above.
- `docs/project-overview.md` — current implementation state, known limitations, and the optimization roadmap.
- `docs/README.md` — index of the public docs.
- `CLAUDE.md` — repository conventions, the agent permission model, and the multi-role key design.

Detailed design documents (data sources, prediction service, decision engine, backtest framework, risk monitoring, treasury design) are internal operator notes maintained outside the public tree — the architecture they describe is summarized in `docs/project-overview.md`.

## Security conventions

- **Never commit `.env` to git** (gitignored by default)
- **Never write `MNEMONICS` to logs** (the code already avoids this)
- **`AGENT_MNEMONICS` and `TREASURY_MNEMONICS` must be different mnemonics** — an agent compromise must not reach treasury funds
- **`EXPECTED_AGENT_ADDRESS` is required** — if unset or malformed in `.env`, `loadConfig` lists every missing field in one batch and exits
- **TOFU identity files** (`./data/agent.identity.json` / `./data/treasury.identity.json`) are written on first run and compared on every subsequent start — a swapped mnemonic fails fast; to rotate intentionally, `rm ./data/*.identity.json` and restart

## `.gitignore` layout

- `tests/`, root markdown, and the public docs (`docs/README.md`, `docs/project-overview.md`) are tracked. Internal design documents (Chinese) under `docs/` are ignored per-file and stay on the operator's machine.
- `scripts/` is entirely untracked — verification probes, bootstrap helpers, and treasury ops scripts are operator-local by convention (see CLAUDE.md "Verification scripts"). The runtime never depends on them.
- `ml/artifacts/` (model artifacts), `ml/data/parquet/`, and `ml/reports/` stay out of git; `ml/uv.lock` is tracked so the training environment is reproducible.
- `/data/` (SQLite), `.env`, `.env.local` are never committed.

## License

Apache-2.0, see `LICENSE`.

## Acknowledgements

Inspired by:
- [Cetus DLMM](https://cetus-1.gitbook.io/cetus-developer-docs/developer/via-dlmm-contract) — the DLMM protocol on Sui
- [CDPM (LeafSheep)](https://github.com/randyPen/cdpm) — the PositionManager permission abstraction; user funds never leave the user's own vault
- Scallop + Kai SAV — lending yield sources
- [SuiAgentsTopUp](https://github.com/RandyPen/SuiAgentsTopUp) — reference implementation of the treasury pattern
