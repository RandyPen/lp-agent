# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Intent

LiquidityManager is an **open-source template** for building DLMM auto-rebalance agents on **Sui**. It operates through the **CDPM (LeafSheep) agent interface** — users own custodied `PositionManager` objects on-chain, and this agent is an authorized operator with a constrained permission set (see *Agent Permission Model* below).

**What the template ships** (the core skeleton — see `README.md` for the open-source-friendly intro):
1. **Algorithm-driven rebalancing** — multi-bin probabilistic strategy (GARCH+log-normal), strategy registry, atomic unified PTB
2. **Idle assets → lending** — Scallop + Kai SAV integration, APY-aware router with tie-break + dust filter
3. **User top-up records** — per-user derivation addresses + watcher + credit ledger + APY rates (Treasury layer)
4. **Extension points** — `Strategy`, `PoolProfile`, lending adapter pattern, `kaiVaults` config — all explicit seams documented in `README.md`

**What the template intentionally does NOT ship** (downstream forks bring their own alpha):
- LLM-driven news ingestion / σ-jump / Strategic Brief — these existed in earlier phases and were stripped during the template extraction
- Cross-chain support — single-chain Sui only
- HTTP API surface — direct CLI + SQLite only; v2 adds HTTP

Design directions captured from `项目.md`:
- Price prediction is probabilistic → place liquidity across **multiple bins weighted by probability**, not a single range.
- Trading-fee–aware rebalancing: a 0.4 % pool fee means an LP order at price P only fills once the market crosses P × (1 + fee). Strategy logic must price this in, and may intentionally hold liquidity through volatility to harvest swap fees.
- Inputs: historical prices first; the architecture leaves room for downstream forks to plug in macro / news feeds.
- Productization follows a **custodial top-up + credit-ledger** model — Treasury v1 implements this in-tree (per-user deposit addresses, credit ledger, APY-rate-driven inbound credits, attemptCharge/refundCharge for rebalance fees).

## Repository Status

Open-source template (~7 kLOC TypeScript, 160 tests). Source under `src/`, tests under `tests/`, scripts under `scripts/`, docs under `docs/`. See `docs/project-overview.md` for a current state map and `docs/module-and-testing.md` for the 6-module layout. `README.md` is the entry point for fork users.

- Runtime preference: **Bun**. Prefer `bun` over `node`/`npm`.
- **`.gitignore` quirks** — read this carefully, several directories are intentionally untracked:
  - `*.md` — all markdown is ignored (this file included). Use `git add -f` to track docs.
  - `/scripts` — the entire scripts dir is untracked. Production utility scripts (`bootstrap-agent-key.ts`, `lending-bootstrap.ts`, `brief-latest.ts`, `print-events.ts`) live here and are kept local.
  - `/tests` — the test suite is also untracked. CI / fresh-clone setups need an explicit re-checkout.
  - `/data` — SQLite database directory.
  - `.env`, `.env.local` — never commit secrets.

## Verification scripts (convention)

**One-off verification / probe / smoke-test code goes in `scripts/`, never in `src/` or `tests/`.** The scripts directory is gitignored, so this kind of code is intentionally local — it's for the operator running on this machine, not part of the agent's runtime surface.

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

The production agent signs from a single Ed25519 address derived from the operator's mnemonic stored in `.env` as `MNEMONICS`. The mapping is fixed:

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
2. Set `EXPECTED_AGENT_ADDRESS=0xf3f8feeba6b94376511dfc38d51ea3f5d2f3d1b70725fa0f50e5253a66d0d0b9` in `.env` so `bun start` refuses to launch if the wrong key is ever loaded.
3. Run `bun run scripts/verify-agent-address.ts` — must print ✅ match.
4. `bun start` — the runtime derives the keypair from `AGENT_MNEMONICS`/`MNEMONICS` at the default path `m/44'/784'/1'/0'/0'` (override via `AGENT_DERIVATION_PATH` if ever needed). No `sui keytool` export step required.
5. Whitelist this address as an agent on any `PositionManager` you want managed.

**Agent key resolution** (`src/sui/keypairs/agent.ts`, precedence top → bottom):
1. `AGENT_PRIVATE_KEY` (bech32 `suiprivkey1…`) — wins if set. Useful when the operator prefers an exported single key over the mnemonic.
2. `AGENT_MNEMONICS` + `AGENT_DERIVATION_PATH` — new role-explicit name, preferred for any future docs/code that ship.
3. `MNEMONICS` + `AGENT_DERIVATION_PATH` — legacy alias kept because operators (including this project's own .env) already use it.

`AGENT_MNEMONICS` wins over `MNEMONICS` when both are set. `EXPECTED_AGENT_ADDRESS` is enforced inside `getAgentKeypair()` regardless of source — mismatch aborts at first key resolution, not just at startup.

## Multi-role keys (forward-looking)

This project will eventually grow a second on-chain identity: the **treasury / deposit-handling address** for the SuiAgentsTopUp-style monetization layer (per `项目.md` and `src/data/feeds` / future treasury module). That address is operationally and cryptographically **independent** of the agent — different mnemonic, different derivation path, different `EXPECTED_*_ADDRESS` guard.

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

The whole point of this template is that downstream forks add their own
features without forking the framework. Four explicit seams,
each with a one-line / one-file extension recipe:

| Extension | Interface | Recipe |
|---|---|---|
| **New strategy** | `src/strategies/types.ts → Strategy` | Implement `Strategy.plan() → StrategyOutput`; register in `src/strategies/registry.ts`; add to `StrategyName` union. Reference: `multiBinSpot.ts`. |
| **New pool profile** | `src/pools/types.ts → PoolProfile` | New file `src/pools/<pair>.ts` exporting `build<Pair>Profile() → PoolProfile`; register in `src/pools/index.ts → BUILDERS`. Reference: `sui-usdc.ts`. |
| **New lending protocol** | `src/sui/lending/types.ts → LendingProtocol` union + adapter pattern | Mirror `src/sui/lending/scallop.ts`; extend `LendingProtocol`; extend `pickHighestApy` in router; add entries to `LENDING_OPPORTUNITIES`. |
| **New lendable coin** | `src/sui/lending/lendingConfig.ts → LENDING_OPPORTUNITIES` + `MIN_LENDING_DELTA_RAW` + `SCALLOP_RESERVES`; `kaiVaults.ts → KAI_VAULTS` if Kai-supported | Edit three (or four) lists — no code change. Operator runbook in `feedback_lending_whitelist.md` (memory). |

When extending the agent with LLM intelligence / news / external signals
(features explicitly stripped during the template extraction), do NOT
re-introduce them inside this repo. Prefer one of:
- Independent process that POSTs signals to a local socket the agent reads
- New `Strategy` impl that calls the LLM directly during `plan()`
- Separate Route-B service (see earlier `service-extraction-analysis.md`
  in git history) — agent calls it over signed HTTPS

The template's value is that it stays small. Don't grow it back.

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

## Open Design Questions

Unresolved at time of init — propose, don't assume:

- **Price-history source**: on-chain pool events vs. external aggregator (e.g. Pyth, CoinGecko) vs. local cache.
- **Probability model for bin weighting**: closed-form (e.g. log-normal around current price) or learned / sampled?
- **Rebalance trigger**: time-based, drift-from-active-bin, fee-revenue-vs-IL, or hybrid?
- **External-data plug-ins**: how macro / news feeds will be ingested and combined with price signals.
- **Custody timing**: when does the SuiAgentsTopUp-style custody layer come in — v0 single-user, or first-class from day one?
