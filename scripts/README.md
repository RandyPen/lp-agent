# scripts/

Operator tooling. Two tiers, and the split is enforced by `.gitignore`:

- **`scripts/*.ts` (tracked)** — the reusable subset a fork needs to actually
  operate the agent. If a tracked doc, the README, or a file under `src/`
  names a script, it lives here.
- **`scripts/local/` (never tracked)** — one-off probes, bootstrap helpers,
  and machine-specific diagnostics. This is the default home for new scripts;
  see `CLAUDE.md` §"Verification scripts (convention)".

None of these are imported by the runtime. They are CLIs you run by hand.

## Recovery

| Script | Why you need it |
|---|---|
| `risk-reset-emergency.ts` | **Un-brick a latched L3 emergency stop.** The L3 circuit survives restarts by rehydrating from `risk_events`, so a tripped agent stays tripped until you clear it here. `src/risk/emergency.ts` prints this script's name when it rehydrates. Run it, then restart. |
| `fund-address-balance.ts` | Top up the agent's gas balance. `src/sui/submit.ts` refuses to submit below `MIN_ADDRESS_BALANCE_MIST` and points here. |

```bash
bun run risk-reset "<reason for the reset>"
bun run scripts/fund-address-balance.ts <amount-sui>
```

## Verification

Run these before your first mainnet start, and again whenever you change pool
or key configuration.

| Script | Checks |
|---|---|
| `verify-agent-address.ts` | The mnemonic derives `EXPECTED_AGENT_ADDRESS`. Probes the common Sui BIP44 paths and reports which one matched. Never prints key material. |
| `verify-treasury-address.ts` | Same, for `EXPECTED_TREASURY_MASTER_ADDRESS`. |
| `probe-bin-orientation.ts` | **Run this for any pool other than SUI/USDC.** Confirms on-chain which side of the active bin holds which physical coin. Getting this backwards is the single most expensive bug in a DLMM agent — the repo shipped it once already. |
| `probe-cdpm-package.ts` | The CDPM object ids in `src/sui/cdpm/package.ts` resolve on-chain. Run after any CDPM re-publish — a re-publish (not an upgrade) changes every id, and event types from the old package silently never match. |
| `verify-data-coverage.ts` | Historical `price_observations` have no gaps big enough to poison a backtest. |

```bash
EXPECTED_AGENT_ADDRESS=0x… bun run verify-agent
```

## Historical data + offline evaluation

The zero-credential loop:

```bash
bun run seed-fixture                                                 # committed fixture, offline
bun run backtest --pool-id=binance:SUIUSDC --strategy=presenceAnchor
```

`seed-fixture.ts` loads `fixtures/suiusdc-1m-1d.csv` (1 day of 1m SUI/USDC
closes). It exists because `api.binance.com` is geo-blocked in some regions
(incl. most CI runners), so neither CI nor the quickstart can depend on it.

For real, current, longer history use `collect-historical.ts` (public Binance
klines, still no keys). `backfill-cetus-events.ts` is the on-chain counterpart
(real pool swaps; needs an RPC endpoint). `shadow-report.ts` scores a shadow run
— the "validate before you go live" step.

## Web portal demo mode

Serve the portal against a seeded dataset instead of a live agent. The UI shows
a **DEMO DATA** banner so sample NAV / fee figures are never mistaken for real
performance:

```bash
bun run scripts/seed-demo-data.ts && bun run scripts/serve-demo-api.ts
cd web && bun run dev
```

## Treasury operator CLI

Only relevant when `TREASURY_ENABLED=true`. `treasury-sweep.ts` and
`treasury-refund.ts` move real funds — read them before you run them.

| Script | Does |
|---|---|
| `treasury-register-user.ts` | Register a user + derive their deposit address |
| `treasury-list-users.ts` / `treasury-list-balances.ts` | Inspect the credit ledger |
| `treasury-update-rate.ts` | Set the credit conversion rate for a coin |
| `treasury-sweep.ts` | Sweep user deposits to the treasury address |
| `treasury-refund.ts` | Refund a user's remaining credit |
