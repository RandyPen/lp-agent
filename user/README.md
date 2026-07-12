# user/

**Your code goes here.** This directory and `agent.config.ts` are the only paths
the framework never writes to — so a fork that keeps its code here pulls
upstream without merge conflicts. Commit both to your fork; they are not
gitignored.

```bash
cp agent.config.example.ts agent.config.ts
STRATEGY=example bun run shadow      # live market data, no keys, no capital
```

Read `exampleStrategy.ts` before writing your own — it documents the two
contracts that are easy to get wrong: the physical coinA/coinB side rule, and
the fact that a higher bin id does **not** mean a higher price on an inverted
pool.

**One ordering rule:** `agent.config.ts` is imported *before* config loads
(config validates `STRATEGY` / `POOL_PROFILE` / `PRICE_FEED` against what you
register). So a module here must not call `loadConfig()` at module scope — take
what you need as a constructor argument instead. A broken config aborts startup;
it never falls back silently.

**Validate before going live:** `bun test` → `bun run backtest` (offline decision
trace, no fees/IL) → `STRATEGY=<yours> bun run shadow` (real fills, zero capital,
score with `bun run shadow-report`) → only then a funded `PositionManager`.
