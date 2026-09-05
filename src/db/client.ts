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
  // systemd timers (collect/score/card) and MCP server processes write the
  // same file; without a busy timeout concurrent writers fail instantly with
  // SQLITE_BUSY instead of waiting for the WAL lock.
  sqlite.exec("PRAGMA busy_timeout = 5000;");
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
  source_layer INTEGER NOT NULL DEFAULT -1,
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

CREATE TABLE IF NOT EXISTS personal_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  head_revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS personal_profile_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_ref TEXT NOT NULL,
  revision INTEGER NOT NULL,
  profile_json TEXT NOT NULL,
  digest TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_profile_revisions_unique ON personal_profile_revisions (profile_ref, revision);

CREATE TABLE IF NOT EXISTS preference_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_ref TEXT NOT NULL,
  opportunity_ref TEXT NOT NULL,
  kind TEXT NOT NULL,
  matched_features_json TEXT NOT NULL DEFAULT '[]',
  project_ref TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_idempotency ON preference_feedback (idempotency_key);
CREATE INDEX IF NOT EXISTS idx_feedback_profile ON preference_feedback (profile_ref, opportunity_ref);

CREATE TABLE IF NOT EXISTS opportunities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT NOT NULL UNIQUE,
  date TEXT NOT NULL,
  cluster_key TEXT NOT NULL,
  topic TEXT NOT NULL,
  hook_family TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL DEFAULT 'default',
  market_score INTEGER NOT NULL,
  evidence_confidence INTEGER NOT NULL,
  degraded INTEGER NOT NULL DEFAULT 0,
  cross_platform INTEGER NOT NULL DEFAULT 0,
  evidence_digest TEXT NOT NULL,
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  builder_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_opportunities_date ON opportunities (date);

CREATE TABLE IF NOT EXISTS opportunity_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  opportunity_ref TEXT NOT NULL,
  daily_item_id INTEGER NOT NULL,
  platform TEXT NOT NULL,
  content_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_opportunity_items_ref ON opportunity_items (opportunity_ref);

CREATE TABLE IF NOT EXISTS morning_editions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  edition_ref TEXT NOT NULL UNIQUE,
  profile_ref TEXT NOT NULL,
  profile_revision INTEGER NOT NULL,
  date TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  builder_version TEXT NOT NULL,
  ranker_version TEXT NOT NULL,
  source_run_refs_json TEXT NOT NULL DEFAULT '[]',
  evidence_digest TEXT NOT NULL,
  status TEXT NOT NULL,
  limitations_json TEXT NOT NULL DEFAULT '[]',
  digest TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_editions_profile_date ON morning_editions (profile_ref, date);

CREATE TABLE IF NOT EXISTS morning_edition_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  edition_ref TEXT NOT NULL,
  position INTEGER NOT NULL,
  opportunity_ref TEXT NOT NULL,
  market_score INTEGER NOT NULL,
  personal_fit INTEGER NOT NULL,
  evidence_confidence INTEGER NOT NULL,
  reason_codes_json TEXT NOT NULL DEFAULT '[]',
  topic TEXT NOT NULL DEFAULT '',
  hook_family TEXT NOT NULL DEFAULT '',
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  degraded INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_edition_entries_ref ON morning_edition_entries (edition_ref);

CREATE TABLE IF NOT EXISTS opportunity_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_ref TEXT NOT NULL,
  opportunity_ref TEXT NOT NULL,
  decision TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  project_ref TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_idempotency ON opportunity_reviews (idempotency_key);
`);
	ensureMorningEditionEntryColumns(sqlite);
	ensureDailyItemColumns(sqlite);
}

function ensureDailyItemColumns(sqlite: Database): void {
	const columns = new Set(
		(sqlite.query("PRAGMA table_info(daily_items)").all() as Array<{ name: string }>).map((column) => column.name),
	);
	// -1 marks rows written before layer tracking existed.
	if (!columns.has("source_layer")) sqlite.exec("ALTER TABLE daily_items ADD COLUMN source_layer INTEGER NOT NULL DEFAULT -1");
}

function ensureMorningEditionEntryColumns(sqlite: Database): void {
	const columns = new Set(
		(sqlite.query("PRAGMA table_info(morning_edition_entries)").all() as Array<{ name: string }>).map((column) => column.name),
	);
	if (!columns.has("topic")) sqlite.exec("ALTER TABLE morning_edition_entries ADD COLUMN topic TEXT NOT NULL DEFAULT ''");
	if (!columns.has("hook_family")) sqlite.exec("ALTER TABLE morning_edition_entries ADD COLUMN hook_family TEXT NOT NULL DEFAULT ''");
	if (!columns.has("source_refs_json")) sqlite.exec("ALTER TABLE morning_edition_entries ADD COLUMN source_refs_json TEXT NOT NULL DEFAULT '[]'");
	if (!columns.has("degraded")) sqlite.exec("ALTER TABLE morning_edition_entries ADD COLUMN degraded INTEGER NOT NULL DEFAULT 0");
}
