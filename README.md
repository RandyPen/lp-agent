# LiquidityManager

> An open-source quantitative liquidity-custody agent for DLMM market-making on Sui: algorithm-driven position rebalancing, idle assets parked in lending protocols, user top-ups with per-action billing. Bun + TypeScript + SQLite, ~16K LOC, 572 bun tests + ~100 pytest tests.

**v1 has landed**: the ML prediction pipeline lives in-tree — a Python training + inference sidecar (`ml/`, managed with uv), the `mlAgent` strategy, a three-state machine (`src/state`), layered circuit-breaker risk controls (`src/risk`), and shadow mode (`src/services/shadowRunner`). **The repo ships the pipeline and the framework, not trained models** — model artifacts stay out of git; forks retrain on the same pipeline. Bring your own strategies, your own pools, your own models.

## What it does

- **Algorithmic rebalancing** — four built-in strategies (`singleBin` / `multiBinSpot` / `emaTrend` / `mlAgent`) covering three paradigms: probability-distribution placement, trend-biased placement, and ML-prediction-driven placement; each rebalance is submitted as one atomic PTB. `mlAgent` degrades explicitly to a Tier 0 rule-based strategy when the sidecar is unavailable.
- **Idle-asset lending** — Scallop + Kai SAV integration, APY-aware router (25 bps Scallop tie-break), per-coin dust thresholds.
- **Multi-source price feeds** — on-chain Cetus `SwapEvent` and Binance REST implementations behind one `PriceFeed` interface, sharing a `price_observations` history table.
- **Automatic PM discovery** — the agent address is derived from `MNEMONICS`, the agent listens for on-chain `AgentAdded` events and adds the `PositionManager` to its monitor; `AgentRemoved` / `PositionManagerClosed` remove it automatically.
- **User top-up accounting** — per-user derived deposit addresses, a SQLite credit ledger, a periodic watcher that credits inbound deposits, APY-aware conversion rates. Deposit addresses typically hold only stablecoins; operator sweep (`treasury-sweep.ts`) and refund (`treasury-refund.ts`) use Sui's protocol-level gasless stablecoin transfers (mainnet, 2026-05-20) for USDC and the other six allowlisted coins — the deposit address needs zero SUI for gas. The watcher merges coin-object balances and address-balance accumulator balances (from gasless deposits) into a single observed total, so both deposit paths are credited correctly. Non-allowlisted coins and the explicit `--force-gas` flag fall back to the legacy coin-object path.
- **CDPM permission boundary** — all operations go through the LeafSheep `PositionManager`; user funds never leave the user's own vault.

## What it does **not** do (deliberately left to forks)

- ❌ No trained models — the ML pipeline is in-tree (`ml/`), but the model artifacts (the alpha) are yours to train
- ❌ No LLM signal layer / news ingestion — future external signals plug in via a `PredictionProvider` decorator or inside the sidecar, never as framework changes
- ❌ No cross-chain support (Sui mainnet only)
- ❌ No public HTTP API — SQLite + CLI scripts only, plus an optional bind-local treasury HTTP API (`TREASURY_HTTP_ENABLED`, off by default; never expose it raw to the internet)
- ❌ No user-initiated refunds (operator sweeps manually)

## Quick start

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

# 3. Verify key derivation
#    Derive the address from your mnemonic at AGENT_DERIVATION_PATH and
#    compare it with EXPECTED_AGENT_ADDRESS — the runtime enforces the
#    match at startup and aborts on mismatch. (scripts/ is operator-local
#    and not shipped; write your own probe there, see CLAUDE.md.)

# 4. Static integrity
bun run typecheck && bun test            # should be 572 pass
cd ml && uv sync && uv run pytest        # (optional) ML pipeline, ~100 pass

# 5. Run
bun start
```

## Extension points (the core value of the template)

Five clearly carved extension seams — each has a ready-made interface; one registration line or one new file is all it takes:

### 1. Add a strategy

```ts
// src/strategies/myStrategy.ts
import type { Strategy } from "./types.ts";

export function createMyStrategy(): Strategy {
  return {
    name: "myStrategy",
    async plan(input) {
      // return { kind: "plan_and_reconcile", plan } | { kind: "quiet" } | ...
    },
  };
}
```

Register: add one line in `src/strategies/registry.ts` and one member to the `StrategyName` union. Then `STRATEGY=myStrategy bun start`. References: `singleBin.ts` / `multiBinSpot.ts`.

### 2. Add a pool profile

```ts
// src/pools/eth-usdc.ts
export function buildEthUsdcProfile(): PoolProfile { /* ... */ }
```

Add one line to the `BUILDERS` map in `src/pools/index.ts`. Then `POOL_PROFILE=eth-usdc bun start`.

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

Implement `PredictionProvider` and plug in your own sidecar / remote service / local implementation — the framework does not change. References: `src/prediction/sidecarProvider.ts` (HTTP → Python sidecar) and `nullProvider.ts` (rule-based fallback). The training pipeline lives in `ml/` (uv-managed, LightGBM quantile models); forks rebuild the training set with the shipped collectors (`cd ml && uv run python -m data.collectors.binance_klines --start … --end …`) and train their own.

## What you bring

| You want to add | The template provides | You do |
|---|---|---|
| LLM signal source | `Strategy.plan()` receives `history: PriceObservation[]` | Bring your own LLM client / RSS scraper / Twitter API and feed it into the decision inside your strategy |
| Cross-chain | (nothing) | Bring a bridge SDK and run it as a separate service outside the main process; do not pollute the treasury module |
| HTTP API | (nothing beyond the optional bind-local treasury API) | Bun ships `Bun.serve()`; add routes in `src/index.ts` — the treasury layer already exposes callable functions like `attemptCharge` / `findUserBySuiAddress` |

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
├── treasury/                 # user top-ups + credit ledger + watcher + charges
├── services/                 # orchestration (rebalancer / executor / subscriptions / treasuryService / shadowRunner)
├── db/                       # SQLite single-file schema (CREATE IF NOT EXISTS, no migrations)
├── lib/                      # utilities: logger / locks / errors
└── backtest/                 # offline strategy replay tooling

ml/                           # Python pipeline (uv-managed): data / features / training / serving / backtest / tests
                              # model artifacts in ml/artifacts/ stay out of git; uv.lock IS tracked for reproducibility
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

Template inspired by:
- [Cetus DLMM](https://docs.cetus.zone/cetus-developer-docs/cetus-dlmm) — the DLMM protocol on Sui
- [CDPM (LeafSheep)](https://github.com/...) — the PositionManager permission abstraction; user funds never leave the user's own vault
- Scallop + Kai SAV — lending yield sources
- [SuiAgentsTopUp](https://github.com/...) — reference implementation of the treasury pattern
