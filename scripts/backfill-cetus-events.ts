/**
 * scripts/backfill-cetus-events.ts
 *
 * Thin CLI over src/data/feeds/cetusEvents.ts → backfillSwapEvents.
 *
 * Backfills Cetus DLMM swap events from the Sui full-node into the local
 * price_observations table. Prices are stored in human USDC-per-SUI units
 * (Binance SUIUSDC convention) — NOT raw lamport ratios.
 *
 * Usage:
 *   bun run scripts/backfill-cetus-events.ts \
 *     --pool-id=0x<poolId> \
 *     --bin-step=50 \
 *     [--from-hours=48] \
 *     [--pool-coin-a-decimals=6] \
 *     [--pool-coin-b-decimals=9] \
 *     [--db-file=./data/app.db]
 *
 * Environment variables:
 *   SUI_GRPC_URL         Full-node URL (default: https://fullnode.mainnet.sui.io:443)
 *   DB_FILE              Path to the SQLite database (default: ./data/app.db)
 *   POOL_ID              Fallback pool id if --pool-id is not passed
 *
 * Resumability: the event_cursor table stores the last-seen cursor per pool.
 * Restart the script to continue from where it left off.
 *
 * For the SUI/USDC mainnet pool (Pool<USDC=6, SUI=9>, binStep=50):
 *   bun run scripts/backfill-cetus-events.ts \
 *     --pool-id=0x64e590b0e4d4f7dfc7ae9fae8e9983cd80ad83b658d8499bf550a9d4f6667076 \
 *     --bin-step=50
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { openDb } from "../src/db/client.ts";
import { backfillSwapEvents, type SwapEventRecord } from "../src/data/feeds/cetusEvents.ts";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SUI_NODE_URL = process.env.SUI_GRPC_URL ?? "https://fullnode.mainnet.sui.io:443";

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let poolId = process.env.POOL_ID ?? "";
let binStep = 50; // default for the mainnet SUI/USDC pool
let fromHours = 0; // 0 = no limit (backfill as far as RPC allows)
let poolCoinADecimals = 6; // USDC for the SUI/USDC pool
let poolCoinBDecimals = 9; // SUI for the SUI/USDC pool
let dbFile = process.env.DB_FILE ?? "./data/app.db";

for (const arg of args) {
  if (arg.startsWith("--pool-id=")) {
    poolId = arg.slice("--pool-id=".length);
  } else if (arg.startsWith("--bin-step=")) {
    binStep = parseInt(arg.slice("--bin-step=".length), 10);
  } else if (arg.startsWith("--from-hours=")) {
    fromHours = parseFloat(arg.slice("--from-hours=".length));
  } else if (arg.startsWith("--pool-coin-a-decimals=")) {
    poolCoinADecimals = parseInt(arg.slice("--pool-coin-a-decimals=".length), 10);
  } else if (arg.startsWith("--pool-coin-b-decimals=")) {
    poolCoinBDecimals = parseInt(arg.slice("--pool-coin-b-decimals=".length), 10);
  } else if (arg.startsWith("--db-file=")) {
    dbFile = arg.slice("--db-file=".length);
  }
}

if (!poolId || !poolId.startsWith("0x")) {
  console.error("ERROR: --pool-id=0x<poolId> is required (or set POOL_ID env var)");
  process.exit(1);
}
if (!Number.isFinite(binStep) || binStep <= 0) {
  console.error("ERROR: --bin-step must be a positive integer");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

mkdirSync(dirname(resolve(dbFile)), { recursive: true });
openDb(dbFile);

// ---------------------------------------------------------------------------
// Raw JSON-RPC queryEvents client — avoids loadConfig()'s full env requirement
// ---------------------------------------------------------------------------

const clientOverride = {
  async queryEvents(queryArgs: {
    query: { MoveEventType: string };
    cursor?: { txDigest: string; eventSeq: string } | null;
    limit: number;
    order: "ascending" | "descending";
  }): Promise<unknown> {
    const resp = await fetch(SUI_NODE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "suix_queryEvents",
        params: [
          queryArgs.query,
          queryArgs.cursor ?? null,
          queryArgs.limit,
          queryArgs.order === "descending",
        ],
      }),
    });
    if (!resp.ok) throw new Error(`queryEvents HTTP ${resp.status}`);
    const json = (await resp.json()) as { result?: unknown; error?: { message?: string } };
    if (!json.result) {
      throw new Error(`queryEvents rpc error: ${json.error?.message ?? "no result"}`);
    }
    return json.result;
  },
};

// ---------------------------------------------------------------------------
// Run backfill
// ---------------------------------------------------------------------------

const fromMs = fromHours > 0 ? Date.now() - fromHours * 3600 * 1000 : undefined;

console.log(`Backfilling Cetus DLMM swap events`);
console.log(`  pool:              ${poolId}`);
console.log(`  binStep:           ${binStep}`);
console.log(`  coinA decimals:    ${poolCoinADecimals}`);
console.log(`  coinB decimals:    ${poolCoinBDecimals}`);
console.log(`  from:              ${fromMs ? new Date(fromMs).toISOString() : "(earliest available)"}`);
console.log(`  node:              ${SUI_NODE_URL}`);
console.log(`  db:                ${dbFile}`);
console.log();

let totalBatches = 0;
let totalEvents = 0;
let firstSample: SwapEventRecord | null = null;
let lastSample: SwapEventRecord | null = null;

await backfillSwapEvents({
  poolId,
  binStep,
  poolCoinADecimals,
  poolCoinBDecimals,
  fromMs,
  clientOverride,
  onBatch: (batch) => {
    totalBatches++;
    totalEvents += batch.length;
    if (!firstSample && batch.length > 0) firstSample = batch[0]!;
    if (batch.length > 0) lastSample = batch[batch.length - 1]!;
    process.stdout.write(`\r  ${totalBatches} pages / ${totalEvents} events`);
  },
});

console.log(`\n\nDone.`);
console.log(`  pages: ${totalBatches}, events: ${totalEvents}`);

if (firstSample) {
  const s: SwapEventRecord = firstSample;
  console.log(
    `  newest: bin=${s.binId} price=${Number(s.price).toFixed(6)} ts=${new Date(s.timestampMs).toISOString()}`,
  );
}
if (lastSample && lastSample !== firstSample) {
  const s: SwapEventRecord = lastSample;
  console.log(
    `  oldest: bin=${s.binId} price=${Number(s.price).toFixed(6)} ts=${new Date(s.timestampMs).toISOString()}`,
  );
}
