/**
 * Backtest CLI. Reads price observations from SQLite and replays them
 * through a named strategy. Does not need AGENT_PRIVATE_KEY or any
 * mainnet config — strictly an offline tool.
 *
 * Usage:
 *   bun run backtest --strategy=multiBinSpot
 *   bun run backtest --strategy=multiBinSpot --from=2026-04-01 --to=2026-05-01
 *   bun run backtest --strategy=singleBin --db=./data/app.db --initial-a=100000000000 --initial-b=250000000
 *   bun run backtest --json    # emit per-tick records as JSON to stdout
 *   bun run backtest --help    # print usage and exit
 */

import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { buildSuiUsdcProfile } from "../pools/sui-usdc.ts";
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
  --strategy=<name>        Strategy to replay (required unless using default).
                           Available: singleBin | multiBinSpot | presenceAnchor | presenceSweep
                           Note: mlAgent cannot be backtested offline — it
                           requires the live Python prediction sidecar. See
                           docs/implementation-plan-v1.md §W5 for the planned
                           shadow-vs-backtest comparison workflow.
  --pool=<name>            Pool profile name. Default: sui-usdc
  --db=<path>              Path to SQLite database. Default: ./data/app.db
  --from=<date|ms>         Start timestamp (ISO date or epoch ms). Default: beginning
  --to=<date|ms>           End timestamp (ISO date or epoch ms). Default: now
  --initial-a=<atomic>     Initial balance of coin A in atomic units. Default: 100000000000
  --initial-b=<atomic>     Initial balance of coin B in atomic units. Default: 250000000
  --history-window-ms=<ms> Price history window for strategy context. Default: 300000 (5 min)
  --json                   Emit per-tick records as JSON lines to stdout
  --help, -h               Print this help and exit

Examples:
  bun run backtest --strategy=multiBinSpot
  bun run backtest --strategy=multiBinSpot --from=2026-04-01 --to=2026-05-01
  bun run backtest --strategy=singleBin --db=./data/app.db --json
`.trimStart();


interface CliArgs {
  pool: string;
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

  // Early friendly error for mlAgent before touching the DB or registry.
  if (args.strategy === "mlAgent") {
    console.error(
      "backtest: mlAgent cannot be backtested offline — it requires the live Python " +
      "prediction sidecar to be running and serving /predict requests.\n" +
      "See docs/implementation-plan-v1.md §W5 for the planned shadow-vs-backtest " +
      "comparison workflow. Use a rule-based strategy (singleBin, multiBinSpot, " +
      "multiBinSpot) for offline replay.",
    );
    process.exit(1);
  }

  if (!isStrategyName(args.strategy)) {
    console.error(
      `Unknown strategy '${args.strategy}'. Available: ${listStrategyNames().filter((s) => s !== "mlAgent").join(", ")}`,
    );
    process.exit(1);
  }

  // Build the pool profile lazily (env-driven).
  const profile = args.pool === "sui-usdc" ? buildSuiUsdcProfile() : null;
  if (!profile) {
    console.error(`Unknown pool profile '${args.pool}'`);
    process.exit(1);
  }
  if (!profile.poolId) {
    console.error(
      `Pool profile '${args.pool}' has empty poolId. Set the appropriate env var.`,
    );
    process.exit(1);
  }

  const observations = loadObservations(args.db, profile.poolId, args.fromMs, args.toMs);
  if (observations.length === 0) {
    console.error(
      `No price observations found in ${args.db} for pool ${profile.poolId}`,
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
