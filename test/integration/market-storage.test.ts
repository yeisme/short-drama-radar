import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type RadarDb } from "../../src/db/client.ts";
import { dailyItems, marketBatches, marketObservations } from "../../src/db/schema.ts";
import { observationsInWindow, saveObservationBatch, saveSource, sourceByRef } from "../../src/market/repository.ts";
import type { MarketObservation, MarketSource } from "../../src/market/domain.ts";

const directories: string[] = [];
const databases: ReturnType<typeof openDb>[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.$client.close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function pathForDb() {
  const dir = mkdtempSync(join(tmpdir(), "radar-market-storage-"));
  directories.push(dir);
  return join(dir, "radar.db");
}
function connect(path = pathForDb()) {
  const db = openDb(path);
  databases.push(db);
  return db;
}
const source: MarketSource = {
  spec: "radar.market_source.v1", source_ref: "hongguo", revision: 1,
  platform: "hongguo", role: "catalog", publisher_group: "hongguo",
  official_identity_evidence: [], market_scope: ["global"], locale: "zh",
  collection_method: "public_page", metric_definitions: [],
  sampling_scope: "Public catalog sample", freshness_budget: 93600,
  readiness: "planned", limitations: [],
};
function observation(ref = "obs-1", itemId = ref): MarketObservation {
  return {
    spec: "radar.market_observation.v1", observation_ref: ref,
    source_ref: source.source_ref, source_revision: 1, source_item_id: itemId,
    source_snapshot_ref: "snapshot-1", observed_at: "2026-09-11T08:00:00Z",
    source_published_at: null, market: "global", market_evidence_refs: [], locale: "zh",
    format: "unknown", production_method: "unknown", production_evidence_refs: [],
    title: "Catalog sample", topics: [], facts: [], evidence_refs: ["evidence-1"],
    collection_run_ref: "run-1", origin: "fixture",
  };
}
function batch(ref = "batch-1", observations: unknown[] = [observation()]) {
  return { ref, source_ref: source.source_ref, source_revision: 1,
    observed_at: "2026-09-11T08:00:00Z", origin: "fixture" as const, observations };
}

test("upgrades a pre-market database twice without changing existing rows", () => {
  const path = pathForDb();
  const old = new Database(path);
  // DDL fixture intentionally models the oldest daily-items schema, before
  // source_layer. Migration must preserve both its row and the default column.
  old.exec(`CREATE TABLE daily_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, platform TEXT NOT NULL,
    content_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '',
    author_id TEXT NOT NULL DEFAULT '', published_at TEXT NOT NULL DEFAULT '',
    metrics_json TEXT NOT NULL DEFAULT '{}', tags_json TEXT NOT NULL DEFAULT '{}',
    score INTEGER NOT NULL DEFAULT 0, confidence INTEGER NOT NULL DEFAULT 0,
    is_new INTEGER NOT NULL DEFAULT 0, degraded INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL, UNIQUE(date, platform, content_id));`);
  old.query("INSERT INTO daily_items (date,platform,content_id,title,updated_at) VALUES (?,?,?,?,?)")
    .run("2026-09-10", "douyin", "legacy-1", "Keep this title", "2026-09-10T00:00:00Z");
  old.close();
  const first = connect(path);
  saveSource(first, source, 0);
  const second = connect(path);
  expect(second.select().from(dailyItems).get()).toMatchObject({ title: "Keep this title", sourceLayer: -1 });
  expect(sourceByRef(second, "hongguo")).toEqual(source);
});

test("source revisions reject stale writers and retain immutable history", () => {
  const db = connect();
  saveSource(db, source, 0);
  const next = { ...source, revision: 2, sampling_scope: "Revised public sample" };
  saveSource(db, next, 1);
  expect(sourceByRef(db, "hongguo", 1)).toEqual(source);
  expect(sourceByRef(db, "hongguo")).toEqual(next);
  expect(() => saveSource(db, { ...next, sampling_scope: "Stale write" }, 1)).toThrow("Source revision changed");
  expect(() => saveSource(db, { ...next, revision: 3, readiness: "qualified", official_identity_evidence: ["identity"] }, 2)).toThrow("qualification evidence");
});

test("same batch is idempotent; same key with different content is rejected", () => {
  const db = connect();
  saveSource(db, source, 0);
  const first = saveObservationBatch(db, batch());
  expect(saveObservationBatch(db, batch())).toEqual({ ...first, reused: true });
  expect(() => saveObservationBatch(db, batch("batch-1", [{ ...observation(), title: "Changed" }]))).toThrow("different content");
  expect(db.select().from(marketObservations).all()).toHaveLength(1);
  expect(observationsInWindow(db, "hongguo", "2026-09-11T08:00:00Z", "2026-09-11T09:00:00Z")).toHaveLength(1);
  expect(observationsInWindow(db, "hongguo", "2026-09-11T07:00:00Z", "2026-09-11T08:00:00Z")).toEqual([]);
});

test("a late identity collision rolls back both earlier inserts and receipt", () => {
  const db = connect();
  saveSource(db, source, 0);
  saveObservationBatch(db, batch("original", [observation("existing", "same-item")]));
  expect(() => saveObservationBatch(db, batch("collision", [
    observation("a-new", "new-item"), observation("z-conflict", "same-item"),
  ]))).toThrow();
  expect(db.select().from(marketObservations).all().map(row => row.ref)).toEqual(["existing"]);
  expect(db.select().from(marketBatches).all().map(row => row.ref)).toEqual(["original"]);
});

test("empty success has a receipt; invalid or cross-source batches write nothing", () => {
  const db = connect();
  expect(() => saveObservationBatch(db, batch())).toThrow("Register the source");
  saveSource(db, source, 0);
  expect(saveObservationBatch(db, batch("empty", [])).observation_refs).toEqual([]);
  expect(() => saveObservationBatch(db, batch("wrong-source", [{ ...observation(), source_ref: "another" }]))).toThrow();
  expect(() => saveObservationBatch(db, batch("malformed", [null]))).toThrow();
  expect(db.select().from(marketBatches).all().map(row => row.ref)).toEqual(["empty"]);
  expect(db.select().from(marketObservations).all()).toEqual([]);
});
