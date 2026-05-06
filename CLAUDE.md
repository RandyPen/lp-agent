# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Intent

LiquidityManager is an AI agent that manages user liquidity on **Cetus DLMM** (Sui) to improve yield. It rebalances positions through the **CDPM (LeafSheep) agent interface** — meaning users own custodied `PositionManager` objects on-chain, and this agent is an authorized operator with a constrained permission set (see *Agent Permission Model* below).

Design directions captured from `项目.md`:
- Price prediction is probabilistic → place liquidity across **multiple bins weighted by probability**, not a single range.
- Trading-fee–aware rebalancing: a 0.4 % pool fee means an LP order at price P only fills once the market crosses P × (1 + fee). Strategy logic must price this in, and may intentionally hold liquidity through volatility to harvest swap fees.
- Inputs: historical prices first; the architecture should leave room to plug in macro / news feeds later.
- Productization will follow a **custodial top-up + credit-ledger** model — users deposit, credits debit per service. Mirror `/Users/panzhaoming/Code/SuiAgentsTopUp` when the time comes (do not build it preemptively).

## Repository Status

**Greenfield.** The only files in the repo are `.gitignore` and `项目.md`. There is no `package.json`, no source tree, no tests, no lint config, and no build/test/lint commands. Do **not** invent commands — establish them only when actual code is added.

- Runtime preference: **Bun**. Prefer `bun` over `node`/`npm`.
- **`.gitignore` quirk**: the gitignore is a single line, `*.md`. All markdown files (this file included) are ignored by default. If you want CLAUDE.md, README.md, etc. tracked, use `git add -f`. Don't be alarmed when markdown changes don't appear in `git status`.

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

## External Integrations

These are absolute paths on the developer's machine, not git submodules. Read them as living documentation, not vendored dependencies.

- **CDPM Agent SDK** — `/Users/panzhaoming/Code/cdpm/skills/cdpm-agent-sdk` — operations available to agent operators (add/remove liquidity, fee collection), event monitoring, error handling, automation strategies. Start here for any rebalancing transaction.
- **CDPM Calculation Skill** — `/Users/panzhaoming/Code/cdpm/skills/cdpm-calculation-skill` — bin price math, liquidity formulas, fee math. Wraps `@cetusprotocol/dlmm-sdk`'s `BinUtils` / `FeeUtils`. Use this for any quantitative work.
- **Cetus DLMM SDK** — npm package `@cetusprotocol/dlmm-sdk` — the underlying protocol SDK. The CDPM skills sit on top of this; use it directly only when the CDPM layer doesn't expose what you need.
- **SuiAgentsTopUp (reference, not a dependency)** — `/Users/panzhaoming/Code/SuiAgentsTopUp` — Bun + SQLite custodial backend with per-user deposit addresses, off-chain credit ledger, signed-message authentication, and Cetus-Aggregator-based treasury swaps. The intended monetization shape for this project; do not import or vendor it, just mirror the pattern when productization begins.

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
