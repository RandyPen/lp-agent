/**
 * Backtest CLI. Reads price observations from SQLite and replays them
 * through a named strategy. Needs no keys and no chain access — strictly an
 * offline tool.
 *
 * Seed the database first (public Binance klines, no credentials), then
 * replay that series by its pool_id key:
 *
 *   bun run collect-historical
 *   bun run backtest --pool-id=binance:SUIUSDC --strategy=presenceAnchor
 *
 * Usage:
 *   bun run backtest --strategy=multiBinSpot
 *   bun run backtest --strategy=multiBinSpot --from=2026-04-01 --to=2026-05-01
 *   bun run backtest --strategy=singleBin --db=./data/app.db --initial-a=100000000000 --initial-b=250000000
 *   bun run backtest --json    # emit per-tick records as JSON to stdout
 *   bun run backtest --help    # print usage and exit
 *
 * Scope: this is a DECISION trace, not a P&L simulator — it reports what the
 * strategy would have done (trigger frequency, bins touched), with no fee, IL,
 * or gas accounting. Do not use it to rank strategies by return.
 */

import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { loadPoolProfile } from "../pools/index.ts";
import { loadExtensions } from "../kit/loadExtensions.ts";
import { isStrategyName, listStrategyNames } from "../strategies/registry.ts";
import { runBacktest } from "./replay.ts";
import type { PriceObservation } from "../domain/types.ts";

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const USAGE = `
backtest — offline strategy replay against historical price_observations

Usage:
  bun run backtest [options]

Options:
  --strategy=<name>        Strategy to replay. Any registered strategy, incl.
                           ones a fork registers via agent.config.ts.
                           Built-ins: singleBin | multiBinSpot | presenceAnchor
                           | presenceSweep
                           Note: mlAgent cannot be backtested offline — it
                           requires the live prediction sidecar. Use shadow mode
                           ('bun run shadow') to evaluate it against live data.
  --pool=<name>            Pool profile name. Default: sui-usdc
  --pool-id=<key>          Replay a specific price_observations.pool_id series,
                           instead of the pool profile's on-chain object id.
                           Use binance:<SYMBOL> for rows written by
                           'bun run collect-historical'. Supplying this also
                           removes the need for SUI_USDC_POOL_ID.
  --db=<path>              Path to SQLite database. Default: ./data/app.db
  --from=<date|ms>         Start timestamp (ISO date or epoch ms). Default: beginning
  --to=<date|ms>           End timestamp (ISO date or epoch ms). Default: now
  --initial-a=<atomic>     Initial balance of coin A in atomic units. Default: 100000000000
  --initial-b=<atomic>     Initial balance of coin B in atomic units. Default: 250000000
  --history-window-ms=<ms> Price history window for strategy context. Default: 300000 (5 min)
  --json                   Emit per-tick records as JSON lines to stdout
  --help, -h               Print this help and exit

Examples:
  # Zero-credential loop: seed public Binance klines, then replay them.
  bun run collect-historical
  bun run backtest --pool-id=binance:SUIUSDC --strategy=presenceAnchor

  # Replay what the live agent recorded for its own pool (needs SUI_USDC_POOL_ID).
  bun run backtest --strategy=multiBinSpot --from=2026-04-01 --to=2026-05-01
  bun run backtest --strategy=singleBin --db=./data/app.db --json
`.trimStart();


interface CliArgs {
  pool: string;
  /**
   * Overrides the `price_observations.pool_id` key to replay from, decoupling
   * it from the pool profile's on-chain object id.
   *
   * Needed because the two writers of that table key rows differently:
   * the live agent writes under the DLMM pool object id, while
   * `scripts/collect-historical.ts` writes public Binance klines under
   * `binance:<SYMBOL>`. Without this flag a fresh clone can collect history
   * but never replay it — the SELECT would filter on a pool id that has no
   * rows. Supplying it also makes SUI_USDC_POOL_ID unnecessary, which is what
   * keeps the collect → backtest loop credential-free.
   */
  poolId: string | null;
  strategy: string;
  db: string;
  fromMs: number | null;
  toMs: number | null;
  initialA: bigint;
  initialB: bigint;
  historyWindowMs: number;
  json: boolean;
}

interface ParseArgsResult {
  args: CliArgs;
  /** true when --help/-h was passed; caller should print usage and exit 0. */
  help: boolean;
}

function parseArgs(argv: string[]): ParseArgsResult {
  const args: CliArgs = {
    pool: "sui-usdc",
    poolId: null,
    strategy: "multiBinSpot",
    db: "./data/app.db",
    fromMs: null,
    toMs: null,
    initialA: 100_000_000_000n,
    initialB: 250_000_000n,
    historyWindowMs: 5 * 60 * 1000,
    json: false,
  };

  for (const raw of argv) {
    if (raw === "--json") {
      args.json = true;
      continue;
    }
    if (raw === "--help" || raw === "-h") {
      return { args, help: true };
    }
    if (!raw.startsWith("--")) continue;
    const eq = raw.indexOf("=");
    if (eq < 0) continue;
    const key = raw.slice(2, eq);
    const val = raw.slice(eq + 1);
    switch (key) {
      case "pool":
        args.pool = val;
        break;
      case "pool-id":
        args.poolId = val;
        break;
      case "strategy":
        args.strategy = val;
        break;
      case "db":
        args.db = val;
        break;
      case "from":
        args.fromMs = parseTimestamp(val);
        break;
      case "to":
        args.toMs = parseTimestamp(val);
        break;
      case "initial-a":
        args.initialA = BigInt(val);
        break;
      case "initial-b":
        args.initialB = BigInt(val);
        break;
      case "history-window-ms":
        args.historyWindowMs = Number(val);
        break;
      default:
        console.warn(`backtest: unknown arg --${key}=${val} (ignored)`);
    }
  }
  return { args, help: false };
}

function parseTimestamp(raw: string): number {
  if (/^\d+$/.test(raw)) return Number(raw);
  const t = Date.parse(raw);
  if (Number.isNaN(t)) throw new Error(`bad timestamp: ${raw}`);
  return t;
}

interface PriceRow {
  pool_id: string;
  source: string;
  price: string;
  observed_ms: number;
}

/**
 * The distinct `pool_id` keys present in the table. Used only to turn an
 * empty-result dead end into an error that tells the operator what they
 * *could* have replayed.
 */
function listPoolIds(dbPath: string): string[] {
  const db = new Database(resolve(dbPath), { readonly: true });
  try {
    return db
      .query<{ pool_id: string }, []>(
        "SELECT DISTINCT pool_id FROM price_observations ORDER BY pool_id",
      )
      .all()
      .map((r) => r.pool_id);
  } finally {
    db.close();
  }
}

function loadObservations(
  dbPath: string,
  poolId: string,
  fromMs: number | null,
  toMs: number | null,
): PriceObservation[] {
  const db = new Database(resolve(dbPath), { readonly: true });
  try {
    const where: string[] = ["pool_id = ?"];
    const params: (string | number)[] = [poolId];
    if (fromMs !== null) {
      where.push("observed_ms >= ?");
      params.push(fromMs);
    }
    if (toMs !== null) {
      where.push("observed_ms <= ?");
      params.push(toMs);
    }
    const sql = `SELECT pool_id, source, price, observed_ms
       FROM price_observations WHERE ${where.join(" AND ")}
       ORDER BY observed_ms ASC`;
    const rows = db.query<PriceRow, typeof params>(sql).all(...params);
    return rows.map((r) => ({
      price: r.price,
      timestampMs: r.observed_ms,
      source: r.source,
    }));
  } finally {
    db.close();
  }
}

function formatDate(ms: number): string {
  return ms ? new Date(ms).toISOString() : "—";
}

function printSummary(summary: import("./types.ts").BacktestSummary): void {
  console.log("");
  console.log(`Backtest summary`);
  console.log(`  pool:               ${summary.poolName}`);
  console.log(`  strategy:           ${summary.strategyName}`);
  console.log(`  window:             ${formatDate(summary.firstTimestampMs)}  →  ${formatDate(summary.lastTimestampMs)}  (${summary.windowDays.toFixed(2)} days)`);
  console.log(`  ticks:              ${summary.totalTicks}`);
  console.log(`  plan_and_reconcile: ${summary.byKind.plan_and_reconcile}`);
  console.log(`  plan_only:          ${summary.byKind.plan_only}`);
  console.log(`  reconcile_only:     ${summary.byKind.reconcile_only}`);
  console.log(`  quiet:              ${summary.byKind.quiet}`);
  console.log(`  unique bins touched: ${summary.uniqueBinsTouched}`);
}

async function main(): Promise<void> {
  const { args, help } = parseArgs(process.argv.slice(2));

  if (help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  // Register the fork's strategies/pools so --strategy and --pool can name them.
  await loadExtensions();

  // Early friendly error for mlAgent before touching the DB or registry.
  if (args.strategy === "mlAgent") {
    console.error(
      "backtest: mlAgent cannot be backtested offline — it requires a live prediction\n" +
      "provider serving /predict requests. To evaluate it against real market data\n" +
      "with no capital at risk, use shadow mode instead: 'bun run shadow'.\n" +
      "For offline replay pick a rule-based strategy (singleBin, multiBinSpot,\n" +
      "presenceAnchor, presenceSweep).",
    );
    process.exit(1);
  }

  if (!isStrategyName(args.strategy)) {
    console.error(
      `Unknown strategy '${args.strategy}'. Available: ${listStrategyNames().filter((s) => s !== "mlAgent").join(", ")}`,
    );
    process.exit(1);
  }

  // Resolved through the registry so a fork's own profile from agent.config.ts
  // is selectable with --pool. The profile is used here purely as metadata
  // (decimals, bin step, orientation) — the backtest never touches the chain —
  // so the on-chain poolId is only required when it also has to serve as the
  // price_observations lookup key, i.e. when --pool-id was not supplied.
  const profile = loadPoolProfile(args.pool, { requirePoolId: args.poolId === null });
  // The pool id is only ever used as the `price_observations.pool_id` lookup
  // key here, never to touch the chain — so an explicit --pool-id makes the
  // profile's on-chain id (and thus SUI_USDC_POOL_ID) unnecessary.
  const seriesId = args.poolId ?? profile.poolId;
  if (!seriesId) {
    console.error(
      `Pool profile '${args.pool}' has empty poolId. Either set the appropriate\n` +
        `env var (e.g. SUI_USDC_POOL_ID), or pass --pool-id=<key> to replay a\n` +
        `series directly — e.g. --pool-id=binance:SUIUSDC for rows written by\n` +
        `'bun run collect-historical'.`,
    );
    process.exit(1);
  }

  const observations = loadObservations(args.db, seriesId, args.fromMs, args.toMs);
  if (observations.length === 0) {
    console.error(
      `No price observations found in ${args.db} for pool_id '${seriesId}'.\n` +
        `Available pool_ids in this database: ${listPoolIds(args.db).join(", ") || "(none — the table is empty)"}\n` +
        `Seed it with 'bun run collect-historical' (public Binance klines, no keys),\n` +
        `then replay with --pool-id=binance:SUIUSDC.`,
    );
    process.exit(1);
  }

  console.log(
    `Loaded ${observations.length} observations from ${formatDate(observations[0]!.timestampMs)} to ${formatDate(observations[observations.length - 1]!.timestampMs)}`,
  );

  const result = await runBacktest({
    profile,
    strategyName: args.strategy,
    observations,
    initialBalanceA: args.initialA,
    initialBalanceB: args.initialB,
    historyWindowMs: args.historyWindowMs,
  });

  if (args.json) {
    for (const tick of result.ticks) {
      process.stdout.write(
        JSON.stringify(tick, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) + "\n",
      );
    }
  }
  printSummary(result.summary);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`backtest: fatal — ${msg}`);
  process.exit(1);
});
