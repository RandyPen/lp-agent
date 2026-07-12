/**
 * Seed price_observations from the committed fixture — no network, no keys.
 *
 * `collect-historical.ts` fetches live Binance klines, but api.binance.com is
 * geo-blocked in some regions (notably the US, incl. most CI runners), so the
 * offline loop cannot depend on it. This seeds the same table from
 * `fixtures/suiusdc-1m-1d.csv` (1 day of 1m SUI/USDC closes) so that
 *
 *   bun run seed-fixture
 *   bun run backtest --pool-id=binance:SUIUSDC --strategy=presenceAnchor
 *
 * works anywhere, offline. Use collect-historical when you want real, current,
 * longer history.
 *
 * Env: DB_FILE (default ./data/app.db)
 */

import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DB_FILE = process.env.DB_FILE ?? "./data/app.db";
const FIXTURE = resolve(import.meta.dir, "..", "fixtures", "suiusdc-1m-1d.csv");
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

console.log(`Seeded ${n} rows into ${DB_FILE} (pool_id="${POOL_ID}").`);
db.close();
