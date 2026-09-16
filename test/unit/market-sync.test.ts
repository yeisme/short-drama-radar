import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { openDb } from "../../src/db/client.ts";
import { marketSyncState } from "../../src/db/schema.ts";
import { initializeMarket } from "../../src/market/sources.ts";
import { MarketStoreError, saveObservationBatch, saveSource } from "../../src/market/repository.ts";
import { MARKET_SYNC_TABLES, type SyncTableDef } from "../../src/market/sync-tables.ts";
import type { CursorValue } from "../../src/market/sync-plan.ts";
import {
  VERIFY_SAMPLE_LIMIT, keyOfRow, rowDigest, syncMarketToPg, verifyMarketPg,
  type ArchivedRow, type PgArchive,
} from "../../src/market/sync.ts";

// Tasks 2.3 + 2.4: the sync engine is exercised against an in-memory archive
// that mirrors PG semantics (insert-ignore + digest lookup); real postgres.js
// writes belong to the integration suite. Coverage: conflict classification,
// cursor/transaction boundaries, the fingerprint gate and --verify.

const FINGERPRINT = "a".repeat(64);

// In-memory stand-in with real insert-ignore semantics and failure injection.
class FakePg implements PgArchive {
  rows = new Map<string, Map<string, { values: Record<string, unknown>; digest: string }>>();
  failAt: { table: string; chunk: number } | null = null; // 1-based chunk of a table that throws
  private chunkCounts = new Map<string, number>();
  inserted: string[] = [];

  private table(def: SyncTableDef) {
    if (!this.rows.has(def.name)) this.rows.set(def.name, new Map());
    return this.rows.get(def.name)!;
  }

  async insertIgnore(def: SyncTableDef, rows: ArchivedRow[]): Promise<CursorValue[][]> {
    const count = (this.chunkCounts.get(def.name) ?? 0) + 1;
    this.chunkCounts.set(def.name, count);
    if (this.failAt && this.failAt.table === def.name && this.failAt.chunk === count) {
      throw new MarketStoreError("pg_unavailable", "injected failure");
    }
    const conflicts: CursorValue[][] = [];
    for (const row of rows) {
      const key = JSON.stringify(keyOfRow(row.values, def));
      if (this.table(def).has(key)) conflicts.push(keyOfRow(row.values, def));
      else {
        this.table(def).set(key, { values: { ...row.values }, digest: row.digest });
        this.inserted.push(`${def.name}:${key}`);
      }
    }
    return conflicts;
  }

  async digestsOf(def: SyncTableDef, keys: CursorValue[][]): Promise<(string | null)[]> {
    return keys.map(key => this.table(def).get(JSON.stringify(key))?.digest ?? null);
  }

  async rowCount(def: SyncTableDef): Promise<number> {
    return this.table(def).size;
  }

  async sample(def: SyncTableDef, limit: number) {
    return [...this.table(def).entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, limit)
      .map(([key, row]) => ({ key: JSON.parse(key) as CursorValue[], digest: row.digest }));
  }

  tamper(def: SyncTableDef, key: CursorValue[]): void {
    const entry = this.table(def).get(JSON.stringify(key));
    if (entry) entry.digest = "sha256:" + "0".repeat(64);
  }
}

function seed(db: ReturnType<typeof openDb>, count: number): void {
  initializeMarket(db);
  saveSource(db, {
    spec: "radar.market_source.v1", source_ref: "hongguo", revision: 2,
    platform: "hongguo", role: "catalog", publisher_group: "hg",
    official_identity_evidence: [], market_scope: ["CN"], locale: "zh",
    collection_method: "public_page", metric_definitions: [], sampling_scope: "Daily public catalog",
    freshness_budget: null, readiness: "planned", limitations: [],
  }, 1);
  for (let i = 0; i < count; i++) {
    const observedAt = `2026-09-15T08:${String(i % 60).padStart(2, "0")}:00Z`;
    saveObservationBatch(db, {
      ref: `batch-${String(i).padStart(3, "0")}`, source_ref: "hongguo", source_revision: 2,
      observed_at: observedAt, origin: "fixture",
      observations: [{
        spec: "radar.market_observation.v1", observation_ref: `obs-${i}`,
        source_ref: "hongguo", source_revision: 2, source_item_id: `item-${i}`,
        source_snapshot_ref: `snapshot-${i}`, observed_at: observedAt,
        source_published_at: null, market: "unknown", market_evidence_refs: [],
        locale: "zh-CN", format: "live_action", production_method: "unknown",
        production_evidence_refs: [], title: `Work ${i}`, topics: [],
        facts: [], evidence_refs: ["evidence-1"], collection_run_ref: "run-1", origin: "fixture",
      }],
    });
  }
}

const batchesDef = MARKET_SYNC_TABLES.find(t => t.name === "market_batches")!;

describe("sync engine: idempotent append-only writes", () => {
  test("first sync archives every allowlisted row; replay is all reused, zero new writes", async () => {
    const db = openDb(":memory:");
    try {
      seed(db, 5);
      const pg = new FakePg();
      const first = await syncMarketToPg(db, pg, FINGERPRINT, {});
      expect(first.resumed).toBe(false);
      const batches = first.tables.find(t => t.table === "market_batches")!;
      expect(batches.rows_synced).toBe(5);
      const observations = first.tables.find(t => t.table === "market_observations")!;
      expect(observations.rows_synced).toBe(5);
      expect(first.rows_reused).toBe(0);
      const writesAfterFirst = pg.inserted.length;
      const second = await syncMarketToPg(db, pg, FINGERPRINT, {});
      expect(second.rows_synced).toBe(0);
      expect(second.rows_reused).toBe(first.rows_synced); // every archived row replays as reused
      expect(pg.inserted.length).toBe(writesAfterFirst); // replay wrote nothing new
    } finally { db.$client.close(); }
  });

  test("the cursor advances only after the PG transaction commits; a mid-run failure resumes", async () => {
    const db = openDb(":memory:");
    try {
      seed(db, 6);
      const pg = new FakePg();
      pg.failAt = { table: "market_batches", chunk: 2 }; // first chunk commits, second fails
      await syncMarketToPg(db, pg, FINGERPRINT, { chunkSize: "2" }).then(
        () => { throw new Error("expected pg_unavailable"); },
        (err: MarketStoreError) => expect(err.code).toBe("pg_unavailable"),
      );
      const state = db.select().from(marketSyncState).where(eq(marketSyncState.tableName, "market_batches")).get();
      expect(state?.rowsSynced).toBe(2); // only the committed chunk advanced
      expect(state?.cursorJson).not.toBeNull();
      pg.failAt = null;
      const resumed = await syncMarketToPg(db, pg, FINGERPRINT, { chunkSize: "2" });
      expect(resumed.resumed).toBe(true);
      const batches = resumed.tables.find(t => t.table === "market_batches")!;
      expect(batches.rows_synced + batches.rows_reused).toBe(4); // remaining rows; none duplicated
      expect(await pg.rowCount(batchesDef)).toBe(6);
    } finally { db.$client.close(); }
  });

  test("same key with a different digest aborts the table with sync_conflict and zero rewrites", async () => {
    const db = openDb(":memory:");
    try {
      seed(db, 3);
      const pg = new FakePg();
      await syncMarketToPg(db, pg, FINGERPRINT, {});
      // Externally tamper one archived row's digest, then add a new local row
      // so the table is walked again.
      pg.tamper(batchesDef, ["batch-001"]);
      const before = await pg.rowCount(batchesDef);
      saveObservationBatch(db, {
        ref: "batch-new", source_ref: "hongguo", source_revision: 2,
        observed_at: "2026-09-15T09:00:00Z", origin: "fixture", observations: [],
      });
      await syncMarketToPg(db, pg, FINGERPRINT, { chunkSize: "1" }).then(
        () => { throw new Error("expected sync_conflict"); },
        (err: MarketStoreError) => {
          expect(err.code).toBe("sync_conflict");
          expect(err.message).toContain("market_batches");
          expect(err.message).toContain("batch-001");
          expect(err.message).toMatch(/sha256:[0-9a-f]{12}/);
          expect(err.message).toContain("zero rewrites");
        },
      );
      expect(await pg.rowCount(batchesDef)).toBe(before); // nothing rewritten, nothing appended after abort
    } finally { db.$client.close(); }
  });

  test("a conflict in one table does not roll back other tables' committed state", async () => {
    const db = openDb(":memory:");
    try {
      seed(db, 2);
      const pg = new FakePg();
      await syncMarketToPg(db, pg, FINGERPRINT, {});
      // Tamper a later table (observations); sources/batches replay as reused
      // and their cursors advance normally before the abort.
      const observationsDef = MARKET_SYNC_TABLES.find(t => t.name === "market_observations")!;
      pg.tamper(observationsDef, ["obs-0"]);
      await syncMarketToPg(db, pg, FINGERPRINT, {}).then(
        () => { throw new Error("expected sync_conflict"); },
        (err: MarketStoreError) => expect(err.code).toBe("sync_conflict"),
      );
      const sourceState = db.select().from(marketSyncState).where(eq(marketSyncState.tableName, "market_sources")).get();
      expect(sourceState?.rowsSynced).toBeGreaterThan(0);
    } finally { db.$client.close(); }
  });
});

describe("sync engine: target fingerprint gate and verify", () => {
  test("a different target refuses to resume without explicit confirmation", async () => {
    const db = openDb(":memory:");
    try {
      seed(db, 2);
      const pg = new FakePg();
      await syncMarketToPg(db, pg, FINGERPRINT, {});
      await syncMarketToPg(db, pg, "b".repeat(64), {}).then(
        () => { throw new Error("expected sync_target_changed"); },
        (err: MarketStoreError) => {
          expect(err.code).toBe("sync_target_changed");
          expect(err.message).toContain("--allow-target-change");
          expect(err.message).toContain("aaaaaaaaaaaa"); // fingerprint prefix only
        },
      );
      // Confirming switches the cursor line to the new target with a fresh replay.
      const fresh = await syncMarketToPg(db, new FakePg(), "b".repeat(64), { allowTargetChange: true });
      expect(fresh.resumed).toBe(false);
      const state = db.select().from(marketSyncState).where(eq(marketSyncState.tableName, "market_batches")).get();
      expect(state?.targetFingerprint).toBe("b".repeat(64));
    } finally { db.$client.close(); }
  });

  test("--reset-cursor requires --confirm-reset, then replays fully as reused", async () => {
    const db = openDb(":memory:");
    try {
      seed(db, 2);
      const pg = new FakePg();
      const first = await syncMarketToPg(db, pg, FINGERPRINT, {});
      await syncMarketToPg(db, pg, FINGERPRINT, { resetCursor: true }).then(
        () => { throw new Error("expected flag_invalid"); },
        (err: MarketStoreError) => expect(err.code).toBe("flag_invalid"),
      );
      const replay = await syncMarketToPg(db, pg, FINGERPRINT, { resetCursor: true, confirmReset: true });
      expect(replay.rows_synced).toBe(0);
      expect(replay.rows_reused).toBe(first.rows_synced); // full replay, everything reused
    } finally { db.$client.close(); }
  });

  test("verify passes after a clean sync and stays zero-write", async () => {
    const db = openDb(":memory:");
    try {
      seed(db, 3);
      const pg = new FakePg();
      await syncMarketToPg(db, pg, FINGERPRINT, {});
      const inserted = pg.inserted.length;
      const report = await verifyMarketPg(db, pg, FINGERPRINT);
      expect(report.ok).toBe(true);
      expect(report.differences).toEqual([]);
      expect(report.tables_checked).toBe(MARKET_SYNC_TABLES.length);
      expect(pg.inserted.length).toBe(inserted); // verify wrote nothing
    } finally { db.$client.close(); }
  });

  test("verify lists tampered rows and missing rows individually", async () => {
    const db = openDb(":memory:");
    try {
      seed(db, 3);
      const pg = new FakePg();
      await syncMarketToPg(db, pg, FINGERPRINT, {});
      pg.tamper(batchesDef, ["batch-000"]);
      const report = await verifyMarketPg(db, pg, FINGERPRINT);
      expect(report.ok).toBe(false);
      const mismatch = report.differences.find(d => d.kind === "digest_mismatch");
      expect(mismatch?.table).toBe("market_batches");
      expect(mismatch?.detail).toContain("batch-000");
      // Delete an archived row: reported as a count diff plus a missing row.
      pg.rows.get("market_observations")!.delete(JSON.stringify(["obs-1"]));
      const second = await verifyMarketPg(db, pg, FINGERPRINT);
      expect(second.differences.some(d => d.kind === "row_count" && d.table === "market_observations")).toBe(true);
      expect(second.differences.some(d => d.kind === "missing_in_archive" && d.detail.includes("obs-1"))).toBe(true);
    } finally { db.$client.close(); }
  });

  test("verify also respects the fingerprint gate", async () => {
    const db = openDb(":memory:");
    try {
      seed(db, 1);
      const pg = new FakePg();
      await syncMarketToPg(db, pg, FINGERPRINT, {});
      await verifyMarketPg(db, pg, "c".repeat(64)).then(
        () => { throw new Error("expected sync_target_changed"); },
        (err: MarketStoreError) => expect(err.code).toBe("sync_target_changed"),
      );
    } finally { db.$client.close(); }
  });

  test("rowDigest is stable across JSON key order and matches the payload contract", async () => {
    const def = MARKET_SYNC_TABLES.find(t => t.name === "market_sources")!;
    const a = rowDigest(def, { ref: "s", revision: 1, payload: '{"b":2,"a":1}' });
    const b = rowDigest(def, { ref: "s", revision: 1, payload: '{"a":1,"b":2}' });
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(rowDigest(def, { ref: "s", revision: 1, payload: '{"a":1,"b":3}' })).not.toBe(a);
    expect(VERIFY_SAMPLE_LIMIT).toBe(100);
  });
});
