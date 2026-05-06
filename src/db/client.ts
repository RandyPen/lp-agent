import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let cached: Database | null = null;

const MIGRATIONS = ["0001_init.sql"];

export function openDb(path: string): Database {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA synchronous = NORMAL");
  runMigrations(db);
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

function runMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_ms INTEGER NOT NULL
    );
  `);
  const here = dirname(fileURLToPath(import.meta.url));
  const applied = new Set<string>(
    db.query<{ filename: string }, []>("SELECT filename FROM schema_migrations").all().map((r) => r.filename),
  );
  for (const file of MIGRATIONS) {
    if (applied.has(file)) continue;
    const sql = readFileSync(resolve(here, "migrations", file), "utf8");
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (filename, applied_ms) VALUES (?, ?)").run(file, Date.now());
    })();
  }
}
