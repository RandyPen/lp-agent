import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let cached: Database | null = null;

const SCHEMA_FILE = "schema.sql";

export function openDb(path: string): Database {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA synchronous = NORMAL");
  // Without this, a second process (operator script, ad-hoc SQL diagnostic)
  // opening the same DB file while the agent is running gets an immediate
  // SQLITE_BUSY instead of waiting for the writer to finish. 5s comfortably
  // covers a single writer transaction under WAL.
  db.exec("PRAGMA busy_timeout = 5000");
  applySchema(db);
  cached = db;
  return db;
}

export function getDb(): Database {
  if (!cached) throw new Error("db not initialized; call openDb() first");
  return cached;
}

export function resetDbCacheForTests(): void {
  if (cached) cached.close();
  cached = null;
}

/**
 * Apply the canonical schema. The file is one big `CREATE TABLE IF NOT EXISTS`
 * + `CREATE INDEX IF NOT EXISTS` block, so re-running on every startup is a
 * cheap no-op once tables exist. No version tracking — adding a table is a
 * one-line edit at the bottom of `schema.sql` and a restart.
 *
 * Non-goal: in-place ALTER for production data. Until the project ships, the
 * DB is considered disposable; `rm ./data/app.db` is the recovery path for any
 * incompatible schema change.
 *
 * DOCUMENTED DEVIATION — `ensureColumns` below: a minimal ADDITIVE-ONLY guard
 * (PRAGMA table_info check → ALTER TABLE ADD COLUMN). It exists because some
 * data must survive mid-flight schema additions — e.g. a 14-day shadow-mode
 * validation window or the live risk_events history — where `rm app.db` would
 * destroy the very evidence being collected. It is NOT a migration system: no
 * version table, additions only, and a failed ALTER throws (fail loud).
 */
function applySchema(db: Database): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(resolve(here, SCHEMA_FILE), "utf8");
  db.exec(sql);
  ensureColumns(db, ADDITIVE_COLUMNS);
  rejectLegacyCenterColumns(db);
}

/**
 * DOCUMENTED DEVIATION #2 — legacy-layout REFUSAL (not a migration): the
 * predictions table's center_q10/center_offset/center_q90 columns were
 * removed 2026-07 with the center prediction head
 * (docs/decision-remove-center-prediction.md). They were NOT NULL, so new
 * code inserting without them would fail on every tick — a silent per-tick
 * degradation. Instead of auto-dropping operator data, refuse to start with
 * the exact remediation. Fresh DBs never hit this (schema.sql no longer has
 * the columns).
 */
function rejectLegacyCenterColumns(db: Database): void {
  const info = db
    .prepare<{ name: string }, []>("PRAGMA table_info(predictions)")
    .all();
  const legacy = ["center_q10", "center_offset", "center_q90"].filter((c) =>
    info.some((col) => col.name === c),
  );
  if (legacy.length === 0) return;
  throw new Error(
    `db: predictions table carries legacy center-prediction columns (${legacy.join(", ")}). ` +
      "The center head was removed (docs/decision-remove-center-prediction.md). " +
      "Archive the DB if you want the historical center values, then run once:\n" +
      legacy.map((c) => `  ALTER TABLE predictions DROP COLUMN ${c};`).join("\n") +
      "\n(sqlite3 <db-file> — requires SQLite ≥ 3.35), or rm the DB file if disposable.",
  );
}

interface AdditiveColumn {
  table: string;
  column: string;
  /** Full ALTER TABLE … ADD COLUMN statement. */
  ddl: string;
}

/**
 * Columns added AFTER a table first shipped. Fresh DBs get them from the
 * CREATE TABLE in schema.sql; pre-existing DBs get them via ALTER here.
 */
const ADDITIVE_COLUMNS: AdditiveColumn[] = [
  {
    table: "shadow_decisions",
    column: "active_bin",
    ddl: "ALTER TABLE shadow_decisions ADD COLUMN active_bin INTEGER",
  },
  {
    table: "shadow_decisions",
    column: "spot_price",
    ddl: "ALTER TABLE shadow_decisions ADD COLUMN spot_price TEXT",
  },
  {
    table: "risk_events",
    column: "source",
    ddl: "ALTER TABLE risk_events ADD COLUMN source TEXT NOT NULL DEFAULT 'live' CHECK(source IN ('live','shadow'))",
  },
  {
    // Treasury watcher confirmation debounce (dip-then-recover double-credit
    // fix). `pending_balance`/`pending_count` track a not-yet-confirmed
    // observed balance change so a restart mid-confirmation resumes rather
    // than re-arming from zero. See src/treasury/watcher.ts.
    table: "treasury_address_balances",
    column: "pending_balance",
    ddl: "ALTER TABLE treasury_address_balances ADD COLUMN pending_balance TEXT",
  },
  {
    table: "treasury_address_balances",
    column: "pending_count",
    ddl: "ALTER TABLE treasury_address_balances ADD COLUMN pending_count INTEGER NOT NULL DEFAULT 0",
  },
  {
    // Correlates a rebalances row to the treasury charge nonce debited for
    // it, so a startup reconciliation sweep can refund the exact charge for
    // a row orphaned by a crash between pre-charge and PTB submission. See
    // reconcileOrphanedRebalances in src/services/rebalancer.ts.
    table: "rebalances",
    column: "charge_nonce",
    ddl: "ALTER TABLE rebalances ADD COLUMN charge_nonce TEXT",
  },
];

/** Test hook: run the additive-column guard against an arbitrary DB. */
export function ensureColumnsForTests(db: Database): void {
  ensureColumns(db, ADDITIVE_COLUMNS);
}

function ensureColumns(db: Database, columns: AdditiveColumn[]): void {
  for (const spec of columns) {
    const info = db
      .prepare<{ name: string }, []>(`PRAGMA table_info(${spec.table})`)
      .all();
    if (info.length === 0) continue; // table absent (schema.sql just created it — impossible; guard anyway)
    if (info.some((c) => c.name === spec.column)) continue;
    // Throw on failure — a silently-missing column would surface later as
    // confusing INSERT errors.
    db.exec(spec.ddl);
  }
}
