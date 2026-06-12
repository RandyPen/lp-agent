# LiquidityManager — Project Overview

> Companion to `module-and-testing.md`, `treasury-role-design.md`, and `forecasting-approach.md`.
> Last updated: 2026-06-11 (v1 rewrite landed). ~16 kLOC TypeScript/Bun + SQLite, plus the `ml/` Python pipeline (uv-managed). 572 bun tests across 31 files + 100 pytest tests, typecheck clean.

This document answers four questions: what this project is, what's actually built, what's intentionally left out (so forks know where to extend), and what's still on the punch list before this template is mainnet-validated.

> **Positioning update (2026-06-11):** the project pivoted from "bare template, alpha
> deferred to forks" to an **open-source quantitative liquidity-custody agent** — the v1 plan
> (`docs/implementation-plan-v1.md`) has **landed**: an in-tree ML pipeline (Python sidecar
> behind a `PredictionProvider` interface), the `mlAgent` strategy, a three-state machine,
> layered risk controls, and a shadow-mode runner. Trained model artifacts stay out of git;
> the repo ships the pipeline, not the alpha. See §3 "v1 modules" for the new modules.

---

## 1. What this project is

LiquidityManager is an **open-source template** for an agent that manages user-custodied liquidity on **Cetus DLMM** (Sui mainnet) through the **CDPM (LeafSheep) `PositionManager`** permission boundary. Users own the funds; the agent is an authorised operator with a hard-bounded permission set:

| CAN | CANNOT |
|---|---|
| Add / remove liquidity from PM balance | Withdraw funds out of the PM |
| Collect fees and rewards into the fee bag | Close positions |
| Transfer fees from fee bag → balance | Authorise / revoke other agents |
| Supply / redeem to Scallop + Kai SAV lending | Modify PM configuration |

The agent loop:

```
  on-chain events  →  subscribe to PMs that whitelisted us
        ↓
  every N seconds: for each subscribed PM
    1. fetch PM state + pool active bin + spot price + history
    2. ask the configured strategy for a RebalancePlan
    3. ask the lending router whether to redeem/supply alongside
    4. (optional) check + pre-debit Treasury credits for PM owner
    5. submit one unified PTB (collect → remove → transfer → redeem → add → supply)
    6. on PTB failure: refund the Treasury charge
    7. record outcome in SQLite + emit JSON log lines
```

The repo ships **four strategies** (`singleBin`, `multiBinSpot`, `emaTrend`, `mlAgent`), **multiple market-data feeds** (`onchain`, `binance`, plus the v1 `binanceMulti` / `derivatives` / `cetusEvents` feeds behind `marketAggregator`), and **one optional monetisation layer** (Treasury v1: per-user deposit addresses + credit ledger + per-tick charge). The architecture has explicit extension points for additional strategies, lending protocols, price-feed sources, prediction providers (`PredictionProvider`), post-v1 Treasury features, and the v2 per-user Seal encrypted-research-report layer — see §4.

---

## 2. Architecture at a glance

```
┌──────────────────────────────────────────────────────────────────────┐
│  src/index.ts  — composition root, starts all schedulers             │
└──────────────────────────────────────────────────────────────────────┘
                    │
         ┌──────────┼──────────────┬─────────────────┐
         ↓          ↓              ↓                 ↓
  ┌────────────┐ ┌────────────┐ ┌──────────────┐ ┌──────────────────┐
  │ subscription│ │ rebalancer │ │  treasury    │ │ priceFeed        │
  │  service    │ │  service   │ │  service     │ │ (onchain|binance)│
  └────────────┘ └─────┬──────┘ └──────┬───────┘ └──────┬───────────┘
                       │                │                │
                       ↓                ↓                ↓
                ┌────────────┐  ┌──────────────┐  ┌──────────────┐
                │ strategy   │  │  watcher /   │  │ price_obs DB │
                │ registry   │  │  charges     │  └──────────────┘
                └─────┬──────┘  └──────────────┘
                      ↓
                ┌─────────────────────────────────────────────┐
                │  forecast layer (volatility • binWeights)   │
                └────────────────────┬────────────────────────┘
                                     ↓
                              ┌─────────────┐
                              │ executor    │
                              │ (unified TX │
                              │  + legacy)  │
                              └──────┬──────┘
                                     ↓
                              ┌─────────────┐
                              │ Sui mainnet │
                              └─────────────┘
```

**Persistence (SQLite, single canonical `src/db/schema.sql`, no version-tracked migrations — `CREATE … IF NOT EXISTS` re-runs on every startup):**
- Core: `subscriptions`, `event_cursor`, `rebalances`, `price_observations`, `position_state`
- Lending: `lending_positions`, `lending_actions`
- Treasury: `treasury_users`, `treasury_credit_rates`, `treasury_address_balances`, `treasury_deposits`, `treasury_service_charges`, `treasury_ops`
- ML / risk (v1): `predictions`, `market_state_history`, `risk_events`, `shadow_decisions`

**Toolchain commitment:** one Bun/TS process plus one optional uv-managed Python sidecar (`ml/serving`, consumed only via HTTP behind `PredictionProvider`; the agent degrades to Tier 0 rule strategies when it is down). No Rust components, no notebooks in the runtime path.

---

## 3. What's actually built

### Strategy & rebalancing
- Four registered strategies (`src/strategies/registry.ts`; `Strategy.plan` is async as of v1):
  - `singleBin` — P0 baseline: all liquidity in the active bin, re-centre on drift.
  - `multiBinSpot` — log-normal distribution across bins, with out-of-range / drift / fees-only triggers and a fee dead-zone derate on bin weights.
  - `emaTrend` — dual-EMA (12/26) trend classifier; tent-shaped weights, range center offset by ±halfWidth/2 toward trend side, ×1.5 skew on the trend side.
  - `mlAgent` — v1 main strategy: consumes `PredictionProvider` output (quantile-derived center/width/probabilities) + the three-state machine's parameters; explicit Tier 0 fallback to rule strategies when the sidecar is unavailable (built via `buildStrategy("mlAgent", mlDeps)`).
- `StrategyOutput` 4-state union (`plan_and_reconcile | plan_only | reconcile_only | quiet`).
- `fillBoundary` persistence in `position_state` (table exists; only consumed by future bid-ask-style strategies — v0 strategies don't write it).
- **Unified rebalance PTB** behind `UNIFIED_TX=true` flag — atomic DLMM ops, single gas envelope. I32 → u32 two's-complement bit serialisation handled correctly in both legacy and unified paths.

### Price feeds
- `src/data/feeds/onchain.ts` — Cetus DLMM `SwapEvent` poll, derives spot + history + OHLCV. Default.
- `src/data/feeds/binance.ts` — Public Binance REST (`/api/v3/ticker/price` + `/api/v3/klines`); CEX side-channel for fuller history and cross-source detrending. Switch via `PRICE_FEED=binance` + `BINANCE_SYMBOL=SUIUSDC`.
- Both write to the shared `price_observations` table (`source` column distinguishes), so `getOhlcv` from either is composable.
- v1 adds richer market-data feeds feeding the ML snapshot (not the `PriceFeed` interface): `binanceMulti.ts` (multi-stream klines/trades), `derivatives.ts` (funding / OI), `cetusEvents.ts` (pool swap-event collector), composed by `src/data/marketAggregator.ts` into the `MarketSnapshot` consumed by `mlAgent` / shadow mode.

### Forecast layer
- EWMA / Parkinson / Garman-Klass σ estimators with sqrt-time scaling (`src/forecast/volatility.ts`). All closed-form; no training. Upgrade path to GARCH-MLE / LightGBM-quantile / LSTM documented in `forecasting-approach.md` §"Upgrading to a learned model".
- Log-normal bin-mass integral with fee dead-zone derate + uniform fallback + `pickBinRange` (`src/forecast/binWeights.ts`).

### Lending integration
- Skill-aligned math (`src/sui/lending/math.ts`): forward predictors (`predictScallopRedeem`, `predictKaiRedeem`) + inverse sizers (`scoinToBurnForTargetNet`, `ytToBurnForTargetNet`) with fee-house yield-fee accounting.
- Cross-protocol whitelist (`src/sui/lending/lendingConfig.ts`): USDC / SUI / DEEP × Scallop + Kai (6 opportunities), per-coin dust floors, `canLend()` / `getMinLendingDeltaRaw()` / `getCandidateOpportunities()` helpers.
- APY tie-break (Scallop wins within 25 bps), `LENDING_SAFE_MARGIN_WRAPPER_RAW` partial-drain floor.
- TTL + inflight-dedup APY cache.

### Treasury v1 (optional monetisation layer)
- Per-user deposit addresses derived from `TREASURY_MNEMONICS` at `TREASURY_USER_BASE_PATH/{index}'`.
- Watcher polls `getAllBalances` per registered user, credits positive deltas atomically. `coin_type` is canonicalised; unconfigured coins are still recorded with `credits_granted=0` for operator backfill.
- `attemptCharge` / `refundCharge` with nonce-based idempotency (`${tickId}:${pmId}`). Rebalancer pre-debits before submitting the PTB; on PTB failure the same nonce is refunded.
- v1 does **not** require user signatures on charges — the on-chain `AgentAdded` event is the implicit authorisation. v2 will add HTTP-API + signature-verified charges (see `treasury-role-design.md` §"What's next").
- Feature-flagged off by default (`TREASURY_ENABLED=false`).

### Identity guards (three layers)
- **L1 — `EXPECTED_AGENT_ADDRESS` is REQUIRED env**. `loadConfig` collects every missing / malformed env field into a single `ConfigError` (one launch attempt surfaces all gaps).
- **L2 — `resolveKeypair` address-match**. Derives address from the configured source, compares against EXPECTED, throws on mismatch.
- **L3 — TOFU identity file** (`<dbDir>/<role>.identity.json`, `src/sui/keypairs/identityFile.ts`). First run writes the derived address + timestamps; subsequent runs verify. Mismatch aborts startup. Kill-switch: `IDENTITY_FILES_DISABLED=true` (tests / dev).
- All three layers run independently — any one of them refusing is enough to stop the process.
- `EXPECTED_TREASURY_MASTER_ADDRESS` remains optional (format-checked when set) since treasury is opt-in via `TREASURY_ENABLED=true`.
- Agent + treasury roles share `src/sui/keypairs/resolve.ts` but never share cache or env reads. Error messages are role-tagged.

### Backtest harness
- `bun run backtest --strategy=… --from=… --to=…` reads `price_observations`, replays through any registered strategy, prints a summary grouped by `StrategyOutput` kind.
- Decision log only — no fee/IL/gas accounting yet (the `ml/backtest` L1 runner covers fee-aware evaluation on the Python side).

### v1 modules (landed per `implementation-plan-v1.md`)
- **Prediction layer** (`src/prediction/`) — `PredictionProvider` interface (`provider.ts`), `SidecarPredictionProvider` (HTTP POST to the local Python sidecar, bounded timeout, explicit `fallback` marking — never throws into the tick), `NullPredictionProvider` (closed-form log-normal; final fallback semantics reference).
- **Three-state machine** (`src/state/`) — `NORMAL` / `TREND` / `EXTREME` with continuous width/bias parameters (`params.ts`), hysteresis + minimum-dwell transitions (`transitions.ts`), history persisted to `market_state_history`.
- **Risk controls** (`src/risk/`) — layered L1/L2/L3 circuits (`circuits.ts`), pre-tick monitor (`monitor.ts`), emergency handling (`emergency.ts`), PnL attribution (`pnlAttribution.ts`); events persisted to `risk_events`.
- **Decision helpers** (`src/decision/`) — diff planner (minimal bin moves), inventory tracking, age-based stop-loss.
- **Shadow mode** (`src/services/shadowRunner.ts`) — runs the full decision path without submitting PTBs; decisions land in `shadow_decisions` for calibration.
- **ML pipeline** (`ml/`, uv-managed Python) — `data/` collectors + parquet store, `features/` (shared by training and serving), `training/` (LightGBM quantile q10/q50/q90 + vol, walk-forward, `models_meta.json` with data window + seed + git sha), `serving/` (FastAPI sidecar), `backtest/` (fee model + L1 runner), 100 pytest tests. Artifacts (`ml/artifacts/`) never committed — forks rebuild the dataset via `scripts/collect-historical.ts` / `scripts/backfill-cetus-events.ts` and train their own.

---

## 4. What's NOT in the template (deferred to forks)

The template is intentionally small. Pieces that were prototyped and then removed (or were never built) — each is a clean extension point:

- **News / LLM σ-jump layer.** An earlier branch shipped Anthropic Haiku-driven news extraction that bumped σ via a `news_events` table. Removed. Forks that want this re-introduce `src/news/` + a `JumpSource` that the strategy can consume via `StrategyInput`.
- **Strategic Brief / macro meta-controller.** A 12h Sonnet-produced "regime" signal that biased bin placement. Removed as out-of-scope for a template; if you want it, build it as a separate service that writes into a side table the strategy reads.
- **Quantile / LightGBM forecasting.** **→ Superseded: now in-tree** as a Python training + inference sidecar (`ml/`) consumed through `src/prediction/provider.ts → PredictionProvider`; see §3 "v1 modules", `implementation-plan-v1.md` and `prediction-service-design.md`. Rule strategies stay as Tier 0 fallback; the rule-based σ layer (EWMA / Parkinson / GK) remains in `src/forecast/`.
- **Skeleton strategies (`curve`, `bidAsk`, `onlyBid`, `onlySell`).** The registry shipped four stub-quiet placeholders; they've been removed. Add new strategies through `src/strategies/registry.ts` — a one-line registration.
- **HTTP API for Treasury.** v1 charges are in-process. Forks that want client-facing top-up + signed-message charging add an HTTP layer (Bun.serve) + ALTER TABLE `treasury_service_charges` ADD `signature`, `message_b64`.
- **Cetus-aggregator sweep.** Operator scripts include `treasury-list-balances` and `treasury-update-rate`, but no auto-swap to a single consolidation asset. The `treasury_ops` table is shaped for this (op_kind `swap`).
- **Encrypted seed-file loading.** Both roles still consume `.env` mnemonics. Forks running this in less-trusted environments should plug in encrypted-at-rest secret resolution behind `src/sui/keypairs/resolve.ts`.
- **Seal encrypted research-report layer (v2).** Per-user model: each user's treasury deposit address (`m/44'/784'/0'/0'/N'`) doubles as their Seal authorised-reader identity. Move contract gates access (Subscription / Allowlist patterns); treasury runtime signs `SessionKey` requests on the user's behalf. Full design in `docs/seal-integration.md`. Env placeholders (`SEAL_*`) are commented-out in `.env.example`.
- **Pyth price feed.** `onchain` and `binance` ship; `pyth` env value is accepted by config parser but startup aborts at the price-feed factory until a fork implements it.

---

## 5. Known debt

These are real items, not bugs causing failures today. Listed by cost of *not* fixing.

**5.1 No mainnet validation cycle.** The full Phase 0/1 stack (PM subscription → rebalance PTB → lending supply/redeem) has not been exercised end-to-end on a real small-balance PM. Unit tests verify *shape*, not behaviour. **Effort:** half a day operator time + a few hundred MIST.

**5.2 Router uses naive proportional redeem sizing.** `src/sui/lending/router.ts` sizes redeems as `marketCoinAmount × wantUnderlying / cachedPrincipal`. The skill-aligned `scoinToBurnForTargetNet` / `ytToBurnForTargetNet` inverse helpers in `math.ts` are **currently unused** — wiring them requires live reserve/vault snapshot reads (Scallop `balance_sheet`, Kai `total_available_balance`). The naive sizing is conservative (over-redeems within `redeemHeadroom`), so it's not broken — just leaving the inverse math idle. **Effort:** ~1 day to add snapshot reader + plumb.

**5.3 Unified PTB doesn't fold lending.** `submitUnifiedRebalance` *can* take `lendingDecisions[]`, but the rebalancer always passes `[]` and routes lending through the separate legacy `executor.{supplyToLending, redeemFromLending}` after the DLMM PTB lands. Properly atomic DLMM-with-lending rebalances need the same snapshot reader as 5.2. **Effort:** same as 5.2 (unblocks both).

**5.4 No gas pre-flight.** A multi-bin rebalance with ~32 bins on both add and remove + 1-2 lending ops can push the unified PTB toward the 1 SUI gas budget. There's no `client.devInspectTransactionBlock(...)` check before submission; if the PTB exceeds budget on mainnet, the entire atomic rebalance fails and the tick is lost. **Effort:** ~half a day (add dry-run mode, parse gas, fall back to smaller bin range).

**5.5 No retry classification.** `executor.ts` catches all errors uniformly and marks the rebalance failed. Transient network / 503 / timeout errors should retry with backoff; Move-abort errors (e.g., `EAmountShortfall 1009`, `EStaleScallopState 1011`) should not. Without this, transient flakes count as real failures and consume cooldown. **Effort:** ~half a day.

**5.6 Test coverage is math-heavy and orchestration-light.** Strong: forecast/, lending/math.ts, treasury/{credits,store,watcher}, lendingConfig, txUnified, both keypair resolvers. Empty: `services/executor.ts`, `services/subscriptions.ts`, `services/rebalancer.tickOne()`, `sui/cdpm/{tx,tx_lending,read,events}.ts`, `sui/lending/router.ts` (`.decide()`), data feeds, locks, config. The **router decision tree** is the single highest-leverage test gap — a bug there mis-allocates user funds.

**5.7 Observability stops at logs.** JSON log lines are good for debugging individual ticks; there are no counters (succeeded vs failed), no histograms (gas used, latency), no gauges (active subscriptions, treasury balances). An operator running this in production needs an external log aggregator to answer "is the agent healthy". **Effort:** ~2 hours to add a tiny `lib/metrics.ts` + expose `GET /metrics` via Bun.serve.

**5.8 Backtest is decision-log only.** No fee/IL/gas accounting. Today the harness can tell you *how often* a strategy fires, not *how much it earns*. This blocks meaningful strategy comparison. **Effort:** ~1 week (proper bin-fill simulation against historical swap events).

---

## 6. Decision map — where to invest next

Next 5 work items ranked by value-per-hour:

| # | Work item | Effort | Unblocks |
|---|---|---|---|
| 1 | **Mainnet validation cycle** (5.1) | 0.5 day | Confidence in the entire stack. Until done, everything else is theoretical. |
| 2 | **Router + rebalancer integration tests** | 1 day | Refactor confidence. Any non-trivial change to `router.decide()` / `tickOne()` is a blind cut today. |
| 3 | **Snapshot reads + fold lending into unified PTB** (5.2 + 5.3) | 1 day | Atomic rebalances. Eliminates the multi-tx race window. Activates the inverse sizing helpers. |
| 4 | **Backtest fee/IL/gas accounting** (5.8) | 1 week | Real strategy evaluation. Prerequisite for any quantile-regression fork being meaningful. |
| 5 | **Treasury v2 (HTTP API + signature-verified charges)** | 2 days | Enables third-party clients to top up + drive charges directly. See `treasury-role-design.md` §"What's next". |

---

## 7. Operator notes

### Production agent identity (mainnet)

| | |
|---|---|
| **Sui address** | `0xf3f8feeba6b94376511dfc38d51ea3f5d2f3d1b70725fa0f50e5253a66d0d0b9` |
| **Derivation** | `m/44'/784'/1'/0'/0'` (Sui Wallet style, **account index 1** — NOT the mnemonic's default address) |
| **Verified by** | `bun run scripts/verify-agent-address.ts` |

The agent mnemonic lives in `.env` as `AGENT_MNEMONICS` (or legacy `MNEMONICS`); the runtime derives via `src/sui/keypairs/agent.ts`. Set `EXPECTED_AGENT_ADDRESS` so `bun start` refuses to launch on mismatch. Operators who prefer to export a single key via `sui keytool` can set `AGENT_PRIVATE_KEY` — it takes precedence.

### Treasury identity (mainnet, when enabled)

- Master at `TREASURY_MASTER_DERIVATION_PATH` (default `m/44'/784'/0'/0'/0'`); per-user deposit addresses at `TREASURY_USER_BASE_PATH/{index}'` (default base `m/44'/784'/0'/0'`, indices ≥ 1).
- Mnemonic MUST be different from the agent mnemonic. Verified by `bun run scripts/verify-treasury-address.ts`.
- Each role's keypair singleton has its own cache — no cross-contamination.

### Commands

- **Run dev**: `bun start` — works without any external services. Treasury defaults to off (`TREASURY_ENABLED=false`).
- **Run backtest**: `bun run backtest --strategy=multiBinSpot` — reads `price_observations` from `./data/app.db`. Needs prior `bun start` runs to populate the table.
- **Verify agent address**: `bun run scripts/verify-agent-address.ts`.
- **Verify treasury address**: `bun run scripts/verify-treasury-address.ts`.
- **Treasury ops**: `bun run scripts/treasury-{register-user,list-users,list-balances,update-rate}.ts`.

### Env (agent role)
- **Required (one of)**: `AGENT_MNEMONICS` (or `MNEMONICS`) + optional `AGENT_DERIVATION_PATH` (default `m/44'/784'/1'/0'/0'`); or `AGENT_PRIVATE_KEY` (`suiprivkey1…` bech32, takes precedence).
- **Required**: `EXPECTED_AGENT_ADDRESS` (64-hex Sui address). `loadConfig` collects every missing / malformed env field into one error.
- **Optional**: `AGENT_IDENTITY_FILE` (override TOFU file path), `IDENTITY_FILES_DISABLED=true` (disable TOFU), `UNIFIED_TX=true`, `LENDING_ENABLED=true|false`, `STRATEGY=singleBin|multiBinSpot|emaTrend|mlAgent`, `PRICE_FEED=onchain|binance`, `BINANCE_SYMBOL=SUIUSDC`; ML/risk knobs (sidecar URL, timeout, shadow mode, risk thresholds) documented in `.env.example`.

### Env (treasury role — when `TREASURY_ENABLED=true`)
- `TREASURY_MNEMONICS` (or `TREASURY_PRIVATE_KEY`), `TREASURY_MASTER_DERIVATION_PATH`, `TREASURY_USER_BASE_PATH`, `EXPECTED_TREASURY_MASTER_ADDRESS` (optional but format-checked when set), `TREASURY_IDENTITY_FILE` (TOFU file path override).
- Pricing knobs: `TREASURY_REBALANCE_BASE_COST` (credits), `TREASURY_REBALANCE_FEE_RATE` (credits per USDC-atomic), `TREASURY_WATCHER_INTERVAL_MS`, `TREASURY_REQUIRE_REGISTRATION`.

### Skills referenced (live, not vendored)
`~/Code/cdpm/skills/cdpm-agent-sdk`, `~/Code/cdpm/skills/cdpm-calculation-skill`, `~/Code/cdpm_web/docs/worker-listen-and-rebalance-reference.md`.

---

## 8. Open questions for forks

Three questions a serious fork will need to answer; the template stays silent on them on purpose.

**Q1 — Forecast horizon and external signals.** σ is scaled to a fixed 30-minute horizon by `multiBinSpot` default. Forks plugging in news / macro / order-book signals must decide whether to adjust σ pre-integration (cheap) or override individual bin weights post-integration (expressive). The current `StrategyInput` is the right plumbing seam.

**Q2 — Multi-PM coordination.** Each PM rebalances independently. If 100 PMs share the same Scallop reserve and all redeem at once, the agent sprays 100 transactions and may thin the cash position. There's no global lending budget, no cross-PM gas budget, no batch aggregation. Required before the agent goes beyond a handful of users.

**Q3 — Treasury monetisation shape.** v1 charges per rebalance with a `base + volume × fee_rate` formula. Real productisation might want: subscription tiers, per-PM caps, refund-on-loss SLAs, or fee discounts on high-volume users. The `treasury_service_charges` schema is general enough to carry any of these via `memo` / future columns, but the pricing model itself is unopinionated by design.
