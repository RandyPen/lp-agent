/**
 * scripts/backfill-cetus-events.ts
 *
 * Backfill Cetus DLMM swap events from the Sui full-node into the local
 * price_observations table. This gives the prediction pipeline historical
 * on-chain price observations alongside the Binance klines.
 *
 * Usage:
 *   bun run scripts/backfill-cetus-events.ts [--pool-id=0x...] [--limit=5000]
 *
 * Environment variables:
 *   SUI_GRPC_URL  Full-node URL (default: https://fullnode.mainnet.sui.io:443)
 *   DB_FILE       Path to the SQLite database (default: ./data/app.db)
 *   POOL_ID       Override for the pool to backfill (required if not in --pool-id arg)
 *
 * This script is part of the reusable subset whitelisted in .gitignore —
 * any fork can rebuild the dataset with it.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DB_FILE = process.env.DB_FILE ?? "./data/app.db";
const SUI_NODE_URL = process.env.SUI_GRPC_URL ?? "https://fullnode.mainnet.sui.io:443";
const DEFAULT_LIMIT = 5000;

// Cetus DLMM SwapEvent type (package::module::Event name).
// The actual package may differ between mainnet versions; confirm via explorer.
const CETUS_DLMM_PACKAGE = "0xc47d9cf8b4ef4cb4f27e5b4f87ffe6b1ad0fce0f7efa4eb2b8b0df96c4c1d33b";
const SWAP_EVENT_TYPE = `${CETUS_DLMM_PACKAGE}::pool::SwapEvent`;

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let poolId = process.env.POOL_ID ?? "";
let limit = DEFAULT_LIMIT;

for (const arg of args) {
  if (arg.startsWith("--pool-id=")) {
    poolId = arg.slice("--pool-id=".length);
  } else if (arg.startsWith("--limit=")) {
    limit = parseInt(arg.slice("--limit=".length), 10);
    if (!Number.isFinite(limit) || limit <= 0) {
      console.error("--limit must be a positive integer");
      process.exit(1);
    }
  }
}

if (!poolId) {
  console.error("ERROR: pool-id is required (set --pool-id=0x... or POOL_ID env var)");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

mkdirSync(dirname(resolve(DB_FILE)), { recursive: true });
const db = new Database(DB_FILE);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS price_observations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    pool_id     TEXT NOT NULL,
    source      TEXT NOT NULL,
    price       TEXT NOT NULL,
    observed_ms INTEGER NOT NULL
  )
`);

// ---------------------------------------------------------------------------
// Query swap events via raw JSON-RPC (no SDK dependency required in script)
// ---------------------------------------------------------------------------

interface SwapEventData {
  pool: string;
  amount_in: string;
  amount_out: string;
  price_impact_fee: string;
  fee_amount: string;
  // The current price after the swap (encoded as a fixedpoint string or ratio).
  after_sqrt_price?: string;
}

interface SuiEventsResponse {
  result: {
    data: Array<{
      parsedJson?: SwapEventData;
      timestampMs?: string;
    }>;
    hasNextPage: boolean;
    nextCursor?: string | null;
  };
}

async function rpcQueryEvents(
  url: string,
  eventType: string,
  cursorParam: string | null,
  pageSize: number,
): Promise<SuiEventsResponse["result"]> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "suix_queryEvents",
    params: [
      { MoveEventType: eventType },
      cursorParam,
      pageSize,
      false, // descending order
    ],
  });
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (!resp.ok) throw new Error(`RPC error: HTTP ${resp.status}`);
  const json = (await resp.json()) as SuiEventsResponse;
  if (!json.result) throw new Error("unexpected RPC response shape");
  return json.result;
}

const insert = db.prepare(
  `INSERT OR IGNORE INTO price_observations (pool_id, source, price, observed_ms)
   VALUES (?, ?, ?, ?)`,
);

let cursor: string | null = null;
let totalInserted = 0;
let page = 0;

console.log(`Backfilling Cetus DLMM swap events for pool ${poolId}...`);
console.log(`Node: ${SUI_NODE_URL}`);

while (totalInserted < limit) {
  const batchSize = Math.min(50, limit - totalInserted);
  const result = await rpcQueryEvents(SUI_NODE_URL, SWAP_EVENT_TYPE, cursor, batchSize);

  const events = result.data;
  if (events.length === 0) break;

  for (const event of events) {
    const data = event.parsedJson;
    if (!data || data.pool !== poolId) continue;

    const tsMs = event.timestampMs ? Number(event.timestampMs) : Date.now();
    const priceStr = data.after_sqrt_price ?? "0";

    insert.run(poolId, "cetus_swap_event", priceStr, tsMs);
    totalInserted++;
  }

  process.stdout.write(`\r  page ${++page}: ${totalInserted} events inserted`);

  if (!result.hasNextPage) break;
  cursor = result.nextCursor ?? null;

  await new Promise((r) => setTimeout(r, 100));
}

console.log(`\nDone. ${totalInserted} swap events written to ${DB_FILE}.`);
db.close();
