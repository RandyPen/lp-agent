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
 */
function applySchema(db: Database): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(resolve(here, SCHEMA_FILE), "utf8");
  db.exec(sql);
}
