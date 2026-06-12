# docs/

Public documentation index for LiquidityManager.

## In this directory

- **[`project-overview.md`](./project-overview.md)** — the one document to read first. Covers what the project is, the architecture at a glance, what is actually built (strategies and rebalancing, price feeds, forecast layer, lending integration, the optional Treasury layer, identity guards, the backtest harness, and the v1 ML modules), what is deliberately left to forks, known debt, a decision map for where to invest next, operator notes (identities, commands, env), and open questions.

## Where the rest lives

- **Extension points** (add a strategy / pool profile / lending protocol / lendable coin / prediction provider) are documented with recipes in the root [`README.md`](../README.md) and, in more architectural detail, in [`CLAUDE.md`](../CLAUDE.md).
- **Repository conventions, the CDPM agent permission model, and the multi-role key design** are in [`CLAUDE.md`](../CLAUDE.md).
- **Detailed design documents** (project background, v1 implementation plan, data sources, forecasting approach, prediction service, decision engine, backtest framework, risk monitoring, treasury role, Seal integration) are internal operator notes written in Chinese and are maintained outside the public tree. The decisions they record are summarized in `project-overview.md` and in the "Design Questions" section of `CLAUDE.md`; if a referenced design doc is missing from your checkout, that is expected.
