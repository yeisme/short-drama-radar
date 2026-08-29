import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import * as schema from "./schema.ts";

export type RadarDb = BunSQLiteDatabase<typeof schema>;

export function openDb(dbPath: string): RadarDb {
  mkdirSync(dirname(dbPath), { recursive: true });
  const sqlite = new Database(dbPath);
  sqlite.exec("PRAGMA journal_mode = WAL;");
  migrate(sqlite);
  return drizzle(sqlite, { schema });
}

// DDL lives here (allowed exception); all business reads/writes go through Drizzle.
function migrate(sqlite: Database): void {
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS raw_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  layer INTEGER NOT NULL,
  source TEXT NOT NULL,
  content_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  author_id TEXT NOT NULL DEFAULT '',
  author_name TEXT NOT NULL DEFAULT '',
  published_at TEXT NOT NULL DEFAULT '',
  metrics_json TEXT NOT NULL DEFAULT '{}',
  payload_hash TEXT NOT NULL DEFAULT '',
  confidence INTEGER NOT NULL DEFAULT 60,
  degraded INTEGER NOT NULL DEFAULT 0,
  fetched_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_raw_snapshots_content ON raw_snapshots (platform, content_id, fetched_at);

CREATE TABLE IF NOT EXISTS daily_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  platform TEXT NOT NULL,
  content_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  author_id TEXT NOT NULL DEFAULT '',
  published_at TEXT NOT NULL DEFAULT '',
  metrics_json TEXT NOT NULL DEFAULT '{}',
  tags_json TEXT NOT NULL DEFAULT '{}',
  score INTEGER NOT NULL DEFAULT 0,
  confidence INTEGER NOT NULL DEFAULT 0,
  is_new INTEGER NOT NULL DEFAULT 0,
  degraded INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE (date, platform, content_id)
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ok',
  summary_json TEXT NOT NULL DEFAULT '{}'
);
`);
}
