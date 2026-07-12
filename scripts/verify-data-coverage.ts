/**
 * scripts/verify-data-coverage.ts
 *
 * Verify how much historical data is available in the price_observations table
 * and whether the coverage is sufficient for the ML pipeline's training window.
 *
 * Usage:
 *   bun run scripts/verify-data-coverage.ts [--pool-id=0x...] [--source=binance_klines]
 *
 * Environment variables:
 *   DB_FILE   Path to the SQLite database (default: ./data/app.db)
 *
 * Prints a summary including:
 *   - Earliest and latest observation timestamps
 *   - Total row count
 *   - Gaps larger than 5 minutes (potential data holes)
 *   - Whether the 6-month training window is met
 */

import { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DB_FILE = process.env.DB_FILE ?? "./data/app.db";
const REQUIRED_DAYS = 180; // 6 months
const GAP_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let poolIdFilter: string | null = null;
let sourceFilter: string | null = null;

for (const arg of args) {
  if (arg.startsWith("--pool-id=")) poolIdFilter = arg.slice("--pool-id=".length);
  else if (arg.startsWith("--source=")) sourceFilter = arg.slice("--source=".length);
}

// ---------------------------------------------------------------------------
// DB
// ---------------------------------------------------------------------------

let db: Database;
try {
  db = new Database(DB_FILE, { readonly: true });
} catch {
  console.error(`ERROR: cannot open database at '${DB_FILE}'. Run collect-historical.ts first.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

interface CoverageSummary {
  pool_id: string;
  source: string;
  row_count: number;
  earliest_ms: number;
  latest_ms: number;
}

let query = `
  SELECT
    pool_id,
    source,
    COUNT(*) as row_count,
    MIN(observed_ms) as earliest_ms,
    MAX(observed_ms) as latest_ms
  FROM price_observations
`;
const clauses: string[] = [];
if (poolIdFilter) clauses.push(`pool_id = '${poolIdFilter.replace(/'/g, "''")}'`);
if (sourceFilter) clauses.push(`source = '${sourceFilter.replace(/'/g, "''")}'`);
if (clauses.length > 0) query += ` WHERE ${clauses.join(" AND ")}`;
query += ` GROUP BY pool_id, source ORDER BY pool_id, source`;

const rows = db.prepare<CoverageSummary, []>(query).all();

if (rows.length === 0) {
  console.log("No price_observations found.");
  console.log(
    `  DB: ${DB_FILE}`,
    poolIdFilter ? `pool_id=${poolIdFilter}` : "",
    sourceFilter ? `source=${sourceFilter}` : "",
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log("=== Price Observations Coverage Report ===");
console.log(`DB: ${DB_FILE}\n`);

let allOk = true;

for (const row of rows) {
  const span = row.latest_ms - row.earliest_ms;
  const spanDays = span / (24 * 60 * 60 * 1000);
  const meetsRequirement = spanDays >= REQUIRED_DAYS;
  if (!meetsRequirement) allOk = false;

  const earliest = new Date(row.earliest_ms).toISOString();
  const latest = new Date(row.latest_ms).toISOString();
  const status = meetsRequirement ? "PASS" : "FAIL";

  console.log(`[${status}] pool_id=${row.pool_id}  source=${row.source}`);
  console.log(`       rows=${row.row_count.toLocaleString()}`);
  console.log(`       earliest=${earliest}`);
  console.log(`       latest=${latest}`);
  console.log(`       span=${spanDays.toFixed(1)} days  (required: ${REQUIRED_DAYS} days)`);

  // Check for large gaps (only feasible for modest row counts to avoid memory issues).
  if (row.row_count < 200_000) {
    const gapQuery = db.prepare<{ observed_ms: number }, [string, string]>(
      `SELECT observed_ms FROM price_observations
       WHERE pool_id = ? AND source = ?
       ORDER BY observed_ms ASC`,
    );
    const timestamps = gapQuery.all(row.pool_id, row.source).map((r) => r.observed_ms);
    const gaps: Array<{ start: number; end: number; gapMs: number }> = [];
    for (let i = 1; i < timestamps.length; i++) {
      const gap = (timestamps[i] ?? 0) - (timestamps[i - 1] ?? 0);
      if (gap > GAP_THRESHOLD_MS) {
        gaps.push({
          start: timestamps[i - 1]!,
          end: timestamps[i]!,
          gapMs: gap,
        });
      }
    }
    if (gaps.length > 0) {
      console.log(`       gaps >${GAP_THRESHOLD_MS / 60_000}min: ${gaps.length} detected`);
      for (const g of gaps.slice(0, 5)) {
        console.log(
          `         ${new Date(g.start).toISOString()} → ${new Date(g.end).toISOString()} (${(g.gapMs / 60_000).toFixed(1)} min)`,
        );
      }
      if (gaps.length > 5) console.log(`         ... and ${gaps.length - 5} more`);
    } else {
      console.log(`       gaps: none detected (threshold=${GAP_THRESHOLD_MS / 60_000} min)`);
    }
  } else {
    console.log(`       gaps: skipped (${row.row_count.toLocaleString()} rows — too large for in-memory scan)`);
  }

  console.log();
}

console.log(`Overall: ${allOk ? "PASS — all sources meet the 6-month requirement" : "FAIL — some sources need more data"}`);
process.exit(allOk ? 0 : 1);
