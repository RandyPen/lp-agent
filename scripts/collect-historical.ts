/**
 * scripts/collect-historical.ts
 *
 * Collect historical OHLCV data from Binance for the SUI/USDT pair and store
 * it in the local SQLite database's price_observations table.
 *
 * Usage:
 *   bun run scripts/collect-historical.ts [--days=30] [--symbol=SUIUSDT]
 *
 * Environment variables:
 *   DB_FILE     Path to the SQLite database (default: ./data/app.db)
 *   SUI_NETWORK Used by loadConfig(); should be set to "mainnet".
 *
 * This script is part of the reusable subset whitelisted in .gitignore —
 * any fork can rebuild the dataset with it.
 * It does NOT modify src/ or tests/.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DB_FILE = process.env.DB_FILE ?? "./data/app.db";
const DEFAULT_DAYS = 30;
const DEFAULT_SYMBOL = "SUIUSDT";
const BAR_LIMIT = 1000; // Binance max klines per request
const BAR_INTERVAL = "1m";

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let daysBack = DEFAULT_DAYS;
let symbol = DEFAULT_SYMBOL;

for (const arg of args) {
  if (arg.startsWith("--days=")) {
    daysBack = parseInt(arg.slice("--days=".length), 10);
    if (!Number.isFinite(daysBack) || daysBack <= 0) {
      console.error("--days must be a positive integer");
      process.exit(1);
    }
  } else if (arg.startsWith("--symbol=")) {
    symbol = arg.slice("--symbol=".length).toUpperCase();
  }
}

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

mkdirSync(dirname(resolve(DB_FILE)), { recursive: true });
const db = new Database(DB_FILE);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");

// Ensure the price_observations table exists (schema.sql CREATE IF NOT EXISTS).
// We can't run the full schema here without the app module, so we create it
// inline if missing.
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
// Fetch historical klines from Binance
// ---------------------------------------------------------------------------

async function fetchKlines(
  sym: string,
  startMs: number,
  endMs: number,
): Promise<Array<{ open: number; high: number; low: number; close: number; ts: number }>> {
  const params = new URLSearchParams({
    symbol: sym,
    interval: BAR_INTERVAL,
    startTime: startMs.toString(),
    endTime: endMs.toString(),
    limit: BAR_LIMIT.toString(),
  });
  const url = `https://api.binance.com/api/v3/klines?${params}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Binance klines failed: HTTP ${resp.status}`);
  }
  const raw: unknown = await resp.json();
  if (!Array.isArray(raw)) throw new Error("unexpected klines response shape");
  return raw.map((row: unknown) => {
    if (!Array.isArray(row)) throw new Error("unexpected kline row shape");
    return {
      ts: Number(row[0]),
      open: parseFloat(String(row[1])),
      high: parseFloat(String(row[2])),
      low: parseFloat(String(row[3])),
      close: parseFloat(String(row[4])),
    };
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const POOL_ID = `binance:${symbol}`;
const endMs = Date.now();
const startMs = endMs - daysBack * 24 * 60 * 60 * 1000;

console.log(`Collecting ${daysBack} days of ${symbol} 1m klines (${new Date(startMs).toISOString()} → now)...`);

const insert = db.prepare(
  `INSERT OR IGNORE INTO price_observations (pool_id, source, price, observed_ms)
   VALUES (?, ?, ?, ?)`,
);

let cursor = startMs;
let totalInserted = 0;

while (cursor < endMs) {
  const bars = await fetchKlines(symbol, cursor, Math.min(cursor + BAR_LIMIT * 60 * 1000, endMs));
  if (bars.length === 0) break;

  for (const bar of bars) {
    insert.run(POOL_ID, "binance_klines", bar.close.toFixed(8), bar.ts);
    totalInserted++;
  }

  const lastBar = bars[bars.length - 1]!;
  cursor = lastBar.ts + 60 * 1000; // advance by 1 minute after the last bar

  // Rate limit: Binance allows ~1200 requests/min on the public API.
  await new Promise((r) => setTimeout(r, 120));

  const progress = Math.min(100, Math.round(((cursor - startMs) / (endMs - startMs)) * 100));
  process.stdout.write(`\r  ${progress}% — ${totalInserted} bars inserted`);
}

console.log(`\nDone. ${totalInserted} rows written to ${DB_FILE} (pool_id="${POOL_ID}").`);
db.close();
