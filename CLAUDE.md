# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Intent

LiquidityManager is an **open-source framework for building non-custodial LP agents** — quantitative liquidity-custody agents for DLMM market-making on **Sui**. It scaffolds the whole agent (custody boundary, L1/L2/L3 risk, atomic multi-protocol execution, idle-asset lending, user portal) behind clean extension seams, and ships a reference quant agent as the worked example. (It began life as a bare template; the v1 plan in `docs/implementation-plan-v1.md` pivoted it to a full quant agent with an in-tree ML pipeline.) It operates through the **CDPM (LeafSheep) agent interface** — users own custodied `PositionManager` objects on-chain, and this agent is an authorized operator with a constrained permission set (see *Agent Permission Model* below).

**What the current code ships** (the core skeleton — see `README.md` for the open-source-friendly intro):
1. **Algorithm-driven rebalancing** — five registered strategies (`presenceAnchor`/`presenceSweep` regime-gated presence mainline, `singleBin` baseline, `multiBinSpot` log-normal Tier 0 fallback, `mlAgent` vol-prediction-driven; `emaTrend` was removed 2026-07 — directional premise falsified, see `docs/decision-remove-center-prediction.md`), strategy registry, atomic unified PTB; `Strategy.plan` is async
2. **Two price feeds** — on-chain Cetus `SwapEvent` (`onchain`) + public Binance REST (`binance`), shared `price_observations` table
3. **Idle assets → lending** — Scallop + Kai SAV integration, APY-aware router with tie-break + dust filter
4. **User top-up records** — per-user derivation addresses + watcher + credit ledger + APY rates (Treasury layer)
5. **Identity guards (3 layers)** — required `EXPECTED_*_ADDRESS` env (with batched `loadConfig` error reporting), in-resolve address-match, TOFU `<dbDir>/<role>.identity.json` file persisted on first run
6. **Auto PM discovery** — `AgentAdded` on-chain events push PMs into the monitor; `AgentRemoved` / `PositionManagerClosed` (or runtime ACL re-check failure) hard-delete the subscription row
7. **Extension points** — `Strategy`, `PoolProfile`, `PriceFeed`, lending adapter pattern, `kaiVaults` config, per-user Seal reader (v2) — all explicit seams documented in `README.md` / `docs/`

**What v1 added in-tree** (per `docs/implementation-plan-v1.md` — pipeline yes, alpha no; landed):
- ML prediction pipeline: Python training + inference **sidecar** (`ml/`, uv-managed; LightGBM **vol-only** since 2026-07 — the q10/q50/q90 center heads were falsified by walk-forward and removed, see `docs/decision-remove-center-prediction.md`; training and serving share the same `ml/features/` code). TS consumes it only through the `PredictionProvider` interface (`src/prediction/`). **No Rust / napi in v1** — decision cadence is minutes, sub-ms inference buys nothing; revisit via the same interface in v2 if cadence drops to seconds.
- Three-state machine (`NORMAL` / `TREND` / `EXTREME`) with continuous width/bias parameters — deliberately NOT the six-state design from early drafts.
- Layered risk controls (L1/L2/L3) + shadow mode, built **before** the model lands (W1–2): for a custody product, circuit breakers and audit logs are the product; the model is swappable alpha.
- Trained model artifacts stay out of git — the repo ships the pipeline and reproducibility (data window + seed + git sha in `models_meta.json`); forks train their own.

**What the project intentionally does NOT ship**:
- LLM-driven news ingestion / σ-jump / Strategic Brief — stripped in the template phase; future external signals enter via a `PredictionProvider` decorator or inside the sidecar, never as framework changes
- Cross-chain support — single-chain Sui only
- Public HTTP API — the only HTTP surface is the bind-local (127.0.0.1) Bun server gated by `TREASURY_HTTP_ENABLED`: treasury endpoints (`src/treasury/httpApi.ts`) + read-only agent-data routes (`src/web/routes.ts`) that back the `web/` portal. Never expose it raw to the internet.
- Encrypted research-report layer via Seal — design is in `docs/seal-integration.md` (per-user model, AGENT keypair NOT involved), env placeholders in `.env.example`; SDK + Move contracts land in v2 forks

Design directions captured from the operator's internal design notes (a Chinese-named markdown file at the repo root, kept local and untracked):
- Price prediction is probabilistic → place liquidity across **multiple bins weighted by probability**, not a single range.
- Trading-fee–aware rebalancing: a 0.4 % pool fee means an LP order at price P only fills once the market crosses P × (1 + fee). Strategy logic must price this in, and may intentionally hold liquidity through volatility to harvest swap fees.
- Inputs: historical prices first; the architecture leaves room for downstream forks to plug in macro / news feeds.
- Productization follows a **custodial top-up + credit-ledger** model — Treasury v1 implements this in-tree (per-user deposit addresses, credit ledger, APY-rate-driven inbound credits, attemptCharge/refundCharge for rebalance fees).

## Repository Status

Open-source quant agent (~18 kLOC TypeScript, 900+ tests; plus the `ml/` Python pipeline, ~100 pytest tests). Source under `src/`, tests under `tests/`, scripts under `scripts/`, docs under `docs/`, ML pipeline under `ml/`. The v1 rewrite landed: `src/prediction` (PredictionProvider + sidecar client), `src/state` (three-state machine), `src/risk` (L1/L2/L3), `src/decision`, `src/data/feeds/{binanceMulti,derivatives,cetusEvents}` + `src/data/marketAggregator`, `src/strategies/mlAgent`, `src/services/shadowRunner`, and the uv-managed `ml/` sidecar (LightGBM quantile training + FastAPI serving). `Strategy.plan` is now async. See `docs/project-overview.md` for a current state map and `docs/module-and-testing.md` for the module layout. `README.md` is the entry point for fork users.

### Load-bearing execution facts (2026-07 wiring/correctness pass)

- **Bin orientation (verified on mainnet, `scripts/probe-bin-orientation.ts`)**: bins ABOVE the active bin hold PHYSICAL coinA only; bins BELOW hold PHYSICAL coinB only; the agent never places on the active bin itself (policy — the chain allows it but charges a composition fee). For the SUI/USDC pool the PHYSICAL order is `Pool<USDC, SUI>` and `PoolProfile.poolCoinAIsQuote=true`: bin id ↑ = USDC-per-SUI price ↓. Every direction-sensitive decision goes through `src/domain/binMath.ts` (`humanPriceForBin` / `binDirection` / `orientationOf`) — never assume "bin up = price up".
- **`PMState.balance.a/b` are PHYSICAL coin amounts** (keyed by the position's `coin_type_a/b`; for SUI/USDC physical A = USDC). `PoolProfile.coinTypeA/decimalsA` are the LOGICAL (base) convention used for lending/labeling — do not mix them into bin/price math.
- **Execution defaults**: `UNIFIED_TX=true` (atomic PTB; legacy multi-tx is opt-out and non-atomic), on-chain + client-side active-bin slippage guard (`SLIPPAGE_MAX_BIN_DRIFT`, DLMM router `validate_active_id_slippage`), idempotent RPC retry (same signed bytes, digest-check first — `src/sui/submit.ts`).
- **Remove proceeds re-plan**: strategies size adds from `balance + fees + pm.positionValue`; the rebalancer dryRuns the remove prefix (`estimateRemoveProceeds`), injects the haircutted proceeds as `positionValue`, and re-runs `plan()` so recenters redeploy the freed principal instead of leaking it to lending.
- **L3 emergency stop**: auto-trips (repeated L2 / outage-with-position / catastrophic PnL / consecutive tx failures), survives restarts via `risk_events` rehydration; reset = `bun run scripts/risk-reset-emergency.ts "<reason>"` + restart. State-machine thresholds are env-tunable (`STATE_*`); risk knobs under `RISK_*` (see `.env.example`).
- **Accounting**: `pnl_ticks` NAV sampling (incl. quiet ticks) feeds `get24hPnlPct` → the L2/L3 daily-loss circuits; `position_lots` carries lot age/cost across full rebuilds for the 4h/12h age stop-loss; shadow validation is scored by `scripts/shadow-report.ts`.
- **Schema**: still single-file CREATE IF NOT EXISTS, plus a documented additive-only `ensureColumns` guard in `src/db/client.ts` (ALTER ADD COLUMN for mid-flight additions like `risk_events.source`; not a migration system).

**Note on doc references**: the detailed design documents under `docs/` (implementation plan, data sources, prediction/decision/backtest/risk designs, treasury, Seal, module-and-testing) are operator-local Chinese notes — gitignored, NOT in the public repo. References to them throughout this file are kept for the operator; in a fresh clone only `docs/README.md` and `docs/project-overview.md` exist.

- Runtime preference: **Bun** for TS. The ML pipeline (`ml/`) is a separate **uv**-managed Python project — two toolchains total, no cargo. The `web/` portal is a third standalone Bun package (Vite + React 19 + `@mysten/dapp-kit-react` 2.x, own lockfile, never imported by the agent runtime); its data channel is the bind-local HTTP API (`src/web/routes.ts` mounted into `src/treasury/httpApi.ts`), and its dev proxy maps `/v1` → `127.0.0.1:8378`.
- **CDPM deployment (2026-07-09)**: `src/sui/cdpm/package.ts` points at the current fresh publish `0x573584cc…` (feeHouse/accessList/adminCap/globalRecord all changed vs the old `0x3e9261…` deployment — it was a re-publish, not an upgrade, so event types from the old id never match). `web/src/lib/cdpm.ts` mirrors these ids and the EnrollWizard refuses to sign if `/v1/agent/summary`'s `cdpmPackage` disagrees. Verified on mainnet via `scripts/probe-cdpm-package.ts`.
- **`.gitignore` layout** (`tests/`, the public docs, and a whitelisted subset of `scripts/` are tracked):
  - Root markdown (`README.md`, `CLAUDE.md`) is tracked; the operator's Chinese-named internal notes file at the repo root stays local (ignored via an ASCII-only pattern).
  - `docs/` — only the English docs are tracked (`docs/README.md`, `docs/project-overview.md`). The detailed Chinese design documents (`implementation-plan-v1.md`, `data-sources.md`, `forecasting-approach.md`, `prediction-service-design.md`, `decision-engine-design.md`, `backtest-framework-design.md`, `risk-monitoring-design.md`, `module-and-testing.md`, `treasury-role-design.md`, `seal-integration.md`, `project-background.md`, `x-article.md`) are ignored per-file and exist only on the operator's machine — they are NOT in the public repo. References to them elsewhere in this file remain valid for the operator but will not resolve in a fresh clone.
  - `/tests` — tracked (first trust signal for an open-source repo).
  - `agent.config.example.ts` + `user/` — tracked. A fork copies the example to `agent.config.ts` and commits it in ITS repo; upstream never creates one.
  - `/scripts/*` — **ignored by default, with an explicit whitelist** (see `.gitignore` + `scripts/README.md`). One-off probes and machine-specific diagnostics go in `scripts/local/` and never ship. But the reusable operator subset IS tracked, because the tracked docs and the runtime reference it.
    - **Invariant: if a tracked file (README, CLAUDE.md, `docs/`, `.env.example`, or anything under `src/`) names a `scripts/<x>.ts`, that script MUST be whitelisted.** This was violated once — the whole directory was blanket-ignored while `src/risk/emergency.ts` told operators to run `scripts/risk-reset-emergency.ts` to clear a latched L3 stop, and `src/sui/submit.ts` pointed at `scripts/fund-address-balance.ts` for gas. Both shipped as dangling references; a fork that tripped L3 was bricked. The `fresh-clone` CI job now enforces this.
  - `/data` — SQLite database directory, ignored.
  - `.env`, `.env.local` — never commit secrets.
  - `ml/.gitignore` keeps `ml/artifacts/`, `ml/data/parquet/`, `ml/reports/`, `.venv` out of git; `ml/uv.lock` IS tracked for reproducibility.
  - CI (`.github/workflows/ci.yml`): `bunx tsc --noEmit` + `bun test`, the `web/` build, `uv run pytest` (in `ml/`), and a **`fresh-clone` job** that extracts only the tracked tree (`git archive HEAD`) and proves a fork with zero credentials can collect history, replay a strategy, and register its own strategy without touching `src/`. License: Apache-2.0 (`LICENSE`).

## Verification scripts (convention)

**One-off verification / probe / smoke-test code goes in `scripts/`, never in `src/` or `tests/`.** The entire scripts directory is gitignored, so this kind of code is intentionally local — it's for the operator running on this machine, not part of the agent's runtime surface.

Use cases that belong here:
- Verifying a mnemonic derives an expected Sui address.
- Probing an external SDK to confirm an ID resolves before wiring into `src/`.
- Reproducing a bug against mainnet with a tiny script before deciding where the fix lives.
- Ad-hoc SQL diagnostics against `./data/app.db`.

Use cases that do **not** belong here:
- Anything the agent actually executes at runtime → `src/`.
- Anything that needs to keep passing on every commit → `tests/`.

When writing a verification script:
- Read inputs from `process.env` (Bun auto-loads `.env`). **Never `Read` the `.env` file directly** — it contains mnemonics, private keys, and API tokens. If you need to confirm an env var is set, check `process.env.NAME` and report only a boolean.
- Print only what the operator needs to see: pass/fail booleans, matched derivation paths, the public address being verified. Never log mnemonics, private keys, or full seeds.
- Name files descriptively: `verify-agent-address.ts`, `probe-scallop-ids.ts`, `dump-recent-rebalances.ts`.

## Agent Identity (mainnet)

The production agent signs from a single Ed25519 address derived from the operator's mnemonic stored in `.env` as `MNEMONICS`. **Single role**: CDPM rebalance / lending PTB signer, whitelisted on each `PositionManager`. The optional Seal encrypted-research-report layer (v2) is **per-user**, not per-agent — each user's treasury deposit address doubles as their own Seal reader identity; the agent keypair is not involved. See `docs/seal-integration.md`.

The mapping is fixed:

| | |
|---|---|
| **Sui address** | `0xf3f8feeba6b94376511dfc38d51ea3f5d2f3d1b70725fa0f50e5253a66d0d0b9` |
| **Derivation path** | `m/44'/784'/1'/0'/0'` *(Sui Wallet style — account index 1, not the default 0)* |
| **Scheme** | Ed25519 |
| **Source** | `MNEMONICS` env var (consumed via `process.env`; never read from `.env` directly) |
| **Verified by** | `bun run scripts/verify-agent-address.ts` |

**Important:** the agent uses **account index 1**, not the wallet's default address. If you generate addresses through the Sui CLI or Sui Wallet using this mnemonic, the first ("default") address is NOT the agent — it's the second one.

Operator setup checklist:
1. Set `MNEMONICS=<phrase>` (or `AGENT_MNEMONICS=<phrase>`, preferred new name) in `.env`.
2. **REQUIRED**: set `EXPECTED_AGENT_ADDRESS=0xf3f8feeba6b94376511dfc38d51ea3f5d2f3d1b70725fa0f50e5253a66d0d0b9` in `.env`. This is enforced at `loadConfig()` — missing or malformed value aborts startup with a single error listing every gap.
3. Run `bun run scripts/verify-agent-address.ts` — must print ✅ match.
4. `bun start` — the runtime derives the keypair from `AGENT_MNEMONICS`/`MNEMONICS` at the default path `m/44'/784'/1'/0'/0'` (override via `AGENT_DERIVATION_PATH` if ever needed). No `sui keytool` export step required.
5. Whitelist this address as an agent on any `PositionManager` you want managed.

**Agent key resolution** (`src/sui/keypairs/agent.ts`, precedence top → bottom):
1. `AGENT_PRIVATE_KEY` (bech32 `suiprivkey1…`) — wins if set. Useful when the operator prefers an exported single key over the mnemonic.
2. `AGENT_MNEMONICS` + `AGENT_DERIVATION_PATH` — new role-explicit name, preferred for any future docs/code that ship.
3. `MNEMONICS` + `AGENT_DERIVATION_PATH` — legacy alias kept because operators (including this project's own .env) already use it.

`AGENT_MNEMONICS` wins over `MNEMONICS` when both are set. `EXPECTED_AGENT_ADDRESS` is enforced inside `getAgentKeypair()` regardless of source — mismatch aborts at first key resolution, not just at startup.

### TOFU identity files (defense in depth)

In addition to the optional `EXPECTED_*_ADDRESS` env guard, the agent and treasury singletons each persist a **trust-on-first-use** record to disk:

- Default location: `<dirname(DB_FILE)>/agent.identity.json` and `treasury.identity.json` (e.g. `./data/agent.identity.json`).
- First run: the derived address is written to the file with `firstSeenMs`.
- Every subsequent run: the file is read; mismatch with the derived address aborts with a `ConfigError` before the keypair gets cached.
- Override path via `AGENT_IDENTITY_FILE` / `TREASURY_IDENTITY_FILE` env vars.
- Kill switch: `IDENTITY_FILES_DISABLED=true` (used by tests and ephemeral dev loops).
- Rotate intentionally: delete the file and restart. The file contains only the public address, source label, derivation path, and timestamps — never seed material.

Both `EXPECTED_*_ADDRESS` and the identity file run; if either fails the role refuses to start. The env guard is the primary safety; the file is a secondary catch for operators who don't pin the expected address in `.env`. See `src/sui/keypairs/identityFile.ts`.

## Multi-role keys (forward-looking)

This project will eventually grow a second on-chain identity: the **treasury / deposit-handling address** for the SuiAgentsTopUp-style monetization layer (per the internal design notes and `src/data/feeds` / future treasury module). That address is operationally and cryptographically **independent** of the agent — different mnemonic, different derivation path, different `EXPECTED_*_ADDRESS` guard.

The codebase is structured so adding the treasury role is a one-file addition, not a refactor:

- **Generic resolver** (`src/sui/keypairs/resolve.ts`) is role-agnostic. Pure function:
  ```
  resolveKeypair({ role, privateKey, mnemonic, derivationPath, expectedAddress })
    → { keypair, address, source }
  ```
  Use this for any new role.
- **Role singleton wrappers** live in `src/sui/keypairs/*.ts` — currently only `agent.ts`. Each role owns a **private cache**; cache must never be shared across roles. Errors and logs always include the role name.
- **Config layer** (`src/config.ts → cfg.keys.<role>`) maps the role's env vars into a `KeyRoleEnvConfig` and hands it to the resolver. Add a new role by adding a new field to `KeyConfig`.

When the treasury role lands, follow this exact shape (do **not** invent a new pattern):

```
.env:
  TREASURY_MNEMONICS=<phrase, distinct from agent>
  TREASURY_DERIVATION_PATH=m/44'/784'/0'/0'/0'           # treasury default; OK to differ from agent's
  EXPECTED_TREASURY_ADDRESS=0x<expected>                  # required for prod
  # optional explicit override:
  TREASURY_PRIVATE_KEY=suiprivkey1…

src/sui/keypairs/treasury.ts                              # mirrors agent.ts, distinct cache
src/config.ts                                              # add `cfg.keys.treasury` field
scripts/verify-treasury-address.ts                         # mirrors verify-agent-address.ts
```

**Invariant**: agent code must not be able to obtain the treasury keypair, and vice versa. Each role's singleton imports nothing from the other role's module. The shared resolver is pure — it cannot accidentally leak one role's cache to the other.

## Agent Permission Model (invariant)

This agent operates through the CDPM `PositionManager`. The CDPM contract enforces a hard permission boundary that **every code path in this repo must respect**. Treat this list as the project's load-bearing invariant.

CDPM package: `0xbb15c25329fbc85b9cc9cc1d37ee2f913696a7c688d0552ca4dc7e3557598541`

What this agent **CAN** do (via `cdpm-agent-sdk`):
- Add liquidity (using funds already in the `PositionManager` balance)
- Remove liquidity (returns to the `PositionManager` balance)
- Collect fees (routed to the position's fee bag)
- Collect rewards (routed to the position's fee bag)
- Transfer fees from the fee bag to the `PositionManager` balance

What this agent **CANNOT** do:
- Withdraw funds out of the `PositionManager` (only the owner can)
- Close positions (only the owner)
- Authorize / revoke other agents (only the owner)
- Modify `PositionManager` configuration

Any code that appears to bypass these constraints is wrong by construction — verify against `cdpm-agent-sdk` before assuming the chain will accept the transaction.

## Extension points for downstream forks

**The load-bearing rule: a fork must never have to edit a file under `src/`.**

Strategies, pools, feeds and the prediction model all register at RUNTIME from
`agent.config.ts` (repo root) via `defineAgent()` — see `src/kit/defineAgent.ts`
and `src/kit/loadExtensions.ts`. The fork's own code lives in `user/`.

Neither path is ever written to by upstream, so a fork pulls upstream forever
without a merge conflict. (They are deliberately NOT gitignored — the fork
commits them; conflict-freedom comes from upstream not touching them.)

This replaced the old design, where `StrategyName` was a closed union and pools
were a closed map, so registering anything meant patching a framework file and
re-resolving the same conflict on every pull. **Do not reintroduce a closed
union over an extension seam.**

| Extension | Interface | Recipe |
|---|---|---|
| **New strategy** | `src/strategies/types.ts → Strategy` | Implement `plan() → StrategyOutput`, then `defineAgent({ strategies: [createMine()] })`. Select with `STRATEGY=mine`. Reference: `user/exampleStrategy.ts`, `multiBinSpot.ts`. |
| **New pool profile** | `src/pools/types.ts → PoolProfile` | Pure data. `defineAgent({ pools: [{ name, build }] })`; select with `POOL_PROFILE=`. **Run `bun run probe-bin-orientation` first on any non-SUI/USDC pool** and set `poolCoinAIsQuote` from what it reports. Reference: `sui-usdc.ts`. |
| **New price feed** | `src/data/priceFeed.ts → PriceFeed` | `defineAgent({ feeds: { pyth: (profile) => ... } })`; select with `PRICE_FEED=pyth`. Built-ins live in `src/data/feedRegistry.ts`. |
| **New prediction model** | `src/prediction/provider.ts → PredictionProvider` | `defineAgent({ prediction: () => createMine() })`, or pick a shipped impl with `PREDICTION_PROVIDER=sidecar\|null`. `null` = NullPredictionProvider: the full ML graph with no Python. The framework never knows what is behind the interface. |
| **New lending protocol** | `src/sui/lending/types.ts → LendingProtocol` union + adapter pattern | **Still a framework edit** (the one remaining closed seam): mirror `scallop.ts`; extend `LendingProtocol`; extend `pickHighestApy` in router; add to `LENDING_OPPORTUNITIES`. |
| **New lendable coin** | `src/sui/lending/lendingConfig.ts → LENDING_OPPORTUNITIES` + `MIN_LENDING_DELTA_RAW` + `SCALLOP_RESERVES`; `kaiVaults.ts → KAI_VAULTS` if Kai-supported | Edit three (or four) lists — no code change. Operator runbook in `feedback_lending_whitelist.md` (memory). |

Ordering constraint: `loadExtensions()` runs BEFORE `loadConfig()` in every
entrypoint (`src/index.ts`, `src/shadowStandalone.ts`, `src/backtest/cli.ts`),
because config validates `STRATEGY` / `POOL_PROFILE` / `PRICE_FEED` against the
registries. Consequence: **a module under `user/` must not call `loadConfig()`
at module scope.** A missing `agent.config.ts` = built-ins only (documented,
intentional); a broken one aborts startup — never a silent fallback.

When extending the agent with LLM intelligence / news / external signals,
do NOT wire them into the framework. Prefer one of:
- A `PredictionProvider` decorator that post-processes predictions (recommended start)
- Signal generation inside the Python sidecar (it's yours to extend)
- New `Strategy` impl that calls the LLM directly during `plan()`

The framework's value is that it stays small; the `ml/` pipeline and the
strategies are the parts meant to grow. Keep the boundary at the seams above.

## External Integrations

These live as sibling repos / skills on the developer's machine (paths shown with `~/` so they don't leak any single operator's home dir). They are **not** git submodules and are not vendored dependencies — read them as living documentation.

- **CDPM Agent SDK** — `~/Code/cdpm/skills/cdpm-agent-sdk` — operations available to agent operators (add/remove liquidity, fee collection), event monitoring, error handling, automation strategies. Start here for any rebalancing transaction.
- **CDPM Calculation Skill** — `~/Code/cdpm/skills/cdpm-calculation-skill` — bin price math, liquidity formulas, fee math. Wraps `@cetusprotocol/dlmm-sdk`'s `BinUtils` / `FeeUtils`. Use this for any quantitative work.
- **Cetus DLMM SDK** — npm package `@cetusprotocol/dlmm-sdk` — the underlying protocol SDK. The CDPM skills sit on top of this; use it directly only when the CDPM layer doesn't expose what you need.
- **SuiAgentsTopUp (reference, not a dependency)** — `~/Code/SuiAgentsTopUp` — Bun + SQLite custodial backend with per-user deposit addresses, off-chain credit ledger, signed-message authentication, and Cetus-Aggregator-based treasury swaps. The intended monetization shape for this project; do not import or vendor it, just mirror the pattern when productization begins.

## Relevant Claude Code Skills

These are loaded in this environment. Reach for them by name when their domain comes up:

- `cetus-dlmm-sdk-skill` — operating Cetus DLMM pools, positions, swaps, fees.
- `cetus-dlmm-interface` — Move-side protocol architecture, bin internals, ACL, flash swaps. Reach for this when behaviour at the contract level matters.
- `sui-client` — reading chain data and building transactions with `@mysten/sui`.
- `sui-transaction-building` — `Transaction` class, command construction, gas, serialization.
- `sui-bcs` — BCS encoding when manually constructing on-chain payloads.
- `cetus-aggregator` — multi-DEX swaps. Relevant only at the treasury / monetization layer (SuiAgentsTopUp pattern), not for DLMM liquidity ops.

## Design Questions — resolved & open

Resolved by the v1 plan (`docs/implementation-plan-v1.md`; don't re-litigate, but flag evidence that contradicts them):

- **Probability model for bin weighting**: ~~LightGBM quantile regression (q10/q50/q90 + vol)~~ **OVERTURNED by evidence 2026-07** (`docs/decision-remove-center-prediction.md`): walk-forward showed the q50 center placed worse than spot (MAE ratio 1.009–1.012) and direction ≈ coin flip, while the vol head beat the EWMA baseline by 20–25 %. The pipeline is vol-only: normal-shaped weights centered on the ACTIVE BIN with σ from the vol head; rule-based log-normal (`multiBinSpot`) stays as Tier 0 fallback. Directional intelligence lives in rule-based regime gates (presence strategies), never in a trained center head — the burden of proof to reintroduce one is in the decision doc.
- **Rebalance trigger**: hybrid — state-machine eval intervals (20/15/1 min) + event-driven (active-bin drift ≥ tolerance, p_break jump, risk signals).
- **Inference architecture**: Python sidecar behind `PredictionProvider`; no Rust in v1 (decision record in `docs/prediction-service-design.md` §1.2).
- **Training data**: 6–12 months Binance backfill; Cetus-side features deferred to v1.1 (insufficient history).
- **External-data plug-ins**: via `PredictionProvider` decorator or inside the sidecar — never framework changes.

Still open — propose, don't assume:

- **Price-history source for runtime**: on-chain pool events vs. external aggregator (e.g. Pyth, CoinGecko) vs. local cache.
- **Custody scaling**: per-PM strategy preferences (`subscriptions.strategy_pref`), multi-pool state machines — v2 territory.
- **Model retraining cadence**: manual after W8; when to automate and what gates an automated promotion.
