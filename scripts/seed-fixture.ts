/**
 * Seed the committed fixtures — no network, no keys, works anywhere.
 *
 * Seeds BOTH tables the two backtest modes need:
 *
 *   price_observations  ← fixtures/suiusdc-1m-1d.csv       (1 day of 1m closes)
 *       bun run backtest --pool-id=binance:SUIUSDC --strategy=presenceAnchor
 *
 *   swap_events         ← fixtures/suiusdc-swaps-7d.jsonl.gz (7 days of REAL
 *                          on-chain Cetus SwapEvents, gzipped: 1.3MB → 183KB)
 *       bun run backtest --mode=pnl --strategy=presenceAnchor
 *
 * The PnL mode needs the raw swap events because it replays actual per-bin
 * fills to compute fee income and IL — a price series alone cannot tell you
 * what a position would have EARNED.
 *
 * These exist because `collect-historical` / `backfill-cetus-events` hit
 * api.binance.com and a Sui full node, and api.binance.com is geo-blocked in
 * some regions (incl. most CI runners). Neither CI nor the quickstart can
 * depend on the network. Use the collectors when you want current, longer data.
 *
 * Env: DB_FILE (default ./data/app.db)
 */

import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DB_FILE = process.env.DB_FILE ?? "./data/app.db";
const FIXTURE = resolve(import.meta.dir, "..", "fixtures", "suiusdc-1m-1d.csv");
const SWAP_FIXTURE = resolve(import.meta.dir, "..", "fixtures", "suiusdc-swaps-7d.jsonl.gz");
/** The mainnet SUI/USDC DLMM pool the swap fixture was collected from. */
const SWAP_POOL_ID = "0x64e590b0e4d4f7dfc7ae9fae8e9983cd80ad83b658d8499bf550a9d4f6667076";
const POOL_ID = "binance:SUIUSDC";
const SOURCE = "binance_klines";

const lines = readFileSync(FIXTURE, "utf8").trim().split("\n");
const header = lines.shift();
if (header !== "observed_ms,price") {
  throw new Error(`unexpected fixture header: ${header}`);
}

mkdirSync(dirname(resolve(DB_FILE)), { recursive: true });
const db = new Database(DB_FILE);
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS price_observations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    pool_id     TEXT NOT NULL,
    source      TEXT NOT NULL,
    price       TEXT NOT NULL,
    observed_ms INTEGER NOT NULL
  )
`);

const insert = db.prepare(
  `INSERT OR IGNORE INTO price_observations (pool_id, source, price, observed_ms)
   VALUES (?, ?, ?, ?)`,
);

let n = 0;
db.transaction(() => {
  for (const line of lines) {
    const [ms, price] = line.split(",");
    if (!ms || !price) throw new Error(`malformed fixture row: ${line}`);
    insert.run(POOL_ID, SOURCE, price, Number(ms));
    n++;
  }
})();

console.log(`Seeded ${n} price rows into ${DB_FILE} (pool_id="${POOL_ID}").`);

// ---------------------------------------------------------------------------
// swap_events — the fill source for `--mode=pnl`
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS swap_events (
    pool_id    TEXT NOT NULL,
    ts_ms      INTEGER NOT NULL,
    tx_digest  TEXT NOT NULL,
    event_seq  TEXT NOT NULL,
    raw        TEXT NOT NULL,
    PRIMARY KEY (tx_digest, event_seq)
  )
`);

const insertSwap = db.prepare(
  `INSERT OR IGNORE INTO swap_events (pool_id, ts_ms, tx_digest, event_seq, raw)
   VALUES (?, ?, ?, ?, ?)`,
);

const swapLines = new TextDecoder()
  .decode(Bun.gunzipSync(readFileSync(SWAP_FIXTURE)))
  .trim()
  .split("\n");

let swaps = 0;
db.transaction(() => {
  for (const line of swapLines) {
    const row = JSON.parse(line) as {
      ts_ms: number;
      tx_digest: string;
      event_seq: string;
      raw: string;
    };
    insertSwap.run(SWAP_POOL_ID, row.ts_ms, row.tx_digest, row.event_seq, row.raw);
    swaps++;
  }
})();

console.log(`Seeded ${swaps} raw swap events (pool_id="${SWAP_POOL_ID}").`);
console.log("");
console.log("Now try:");
console.log("  bun run backtest --pool-id=binance:SUIUSDC --strategy=presenceAnchor   # what it would DO");
console.log(`  SUI_USDC_POOL_ID=${SWAP_POOL_ID} \\`);
console.log("    bun run backtest --mode=pnl --strategy=presenceAnchor                # what it would EARN");
db.close();
