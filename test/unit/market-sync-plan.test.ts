import { describe, expect, test } from "bun:test";
import { openDb } from "../../src/db/client.ts";
import { saveObservationBatch, saveSource, MarketStoreError } from "../../src/market/repository.ts";
import { initializeMarket } from "../../src/market/sources.ts";
import { syncTableDef } from "../../src/market/sync-tables.ts";
import {
  DEFAULT_CHUNK_SIZE, MAX_CHUNK_SIZE, cursorOfRow, normalizeChunkSize, parseCursor, readChunk, serializeCursor,
} from "../../src/market/sync-plan.ts";

// Task 2.2: chunk boundaries are deterministic, replaying a chunk is
// idempotent, rows inserted between chunks are picked up, and corrupt cursors
// fail closed with cursor_invalid instead of silently restarting.

const batches = syncTableDef("market_batches");

function seedBatches(db: ReturnType<typeof openDb>, count: number, day = "2026-09-15"): string[] {
  initializeMarket(db);
  saveSource(db, {
    spec: "radar.market_source.v1", source_ref: "hongguo", revision: 2,
    platform: "hongguo", role: "catalog", publisher_group: "hg",
    official_identity_evidence: [], market_scope: ["CN"], locale: "zh",
    collection_method: "public_page", metric_definitions: [], sampling_scope: "Daily public catalog",
    freshness_budget: null, readiness: "planned", limitations: [],
  }, 1);
  const refs: string[] = [];
  for (let i = 0; i < count; i++) {
    const ref = `batch-${String(i).padStart(3, "0")}`;
    const observedAt = `${day}T08:${String(i % 60).padStart(2, "0")}:00Z`;
    saveObservationBatch(db, {
      ref, source_ref: "hongguo", source_revision: 2, observed_at: observedAt, origin: "fixture",
      observations: [{
        spec: "radar.market_observation.v1", observation_ref: `obs-${ref}`,
        source_ref: "hongguo", source_revision: 2, source_item_id: `item-${i}`,
        source_snapshot_ref: `snapshot-${i}`, observed_at: observedAt,
        source_published_at: null, market: "unknown", market_evidence_refs: [],
        locale: "zh-CN", format: "live_action", production_method: "unknown",
        production_evidence_refs: [], title: `Work ${i}`, topics: [],
        facts: [], evidence_refs: ["evidence-1"], collection_run_ref: "run-1", origin: "fixture",
      }],
    });
    refs.push(ref);
  }
  return refs;
}

describe("sync chunk planning", () => {
  test("chunk size defaults to 500 and is bounded to 1..5000", () => {
    expect(normalizeChunkSize(undefined)).toBe(DEFAULT_CHUNK_SIZE);
    expect(normalizeChunkSize("1")).toBe(1);
    expect(normalizeChunkSize(String(MAX_CHUNK_SIZE))).toBe(MAX_CHUNK_SIZE);
    for (const bad of ["0", "5001", "1.5", "abc", "-3"]) {
      try {
        normalizeChunkSize(bad);
        throw new Error("expected flag_invalid");
      } catch (err) {
        expect((err as MarketStoreError).code).toBe("flag_invalid");
      }
    }
  });

  test("an empty table yields one empty chunk and no cursor", () => {
    const db = openDb(":memory:");
    try {
      const chunk = readChunk(db, batches, null, 10);
      expect(chunk.rows).toEqual([]);
      expect(chunk.nextCursor).toBeNull();
    } finally { db.$client.close(); }
  });

  test("multi-chunk walk is deterministic, ordered and gap-free", () => {
    const db = openDb(":memory:");
    try {
      seedBatches(db, 7);
      const seen: string[] = [];
      let cursor: ReturnType<typeof parseCursor> = null;
      for (let guard = 0; guard < 10; guard++) {
        const chunk = readChunk(db, batches, cursor, 3);
        seen.push(...chunk.rows.map(r => r.ref as string));
        if (!chunk.nextCursor) break;
        cursor = chunk.nextCursor;
      }
      expect(seen).toHaveLength(7);
      expect(new Set(seen).size).toBe(7);
      // Deterministic order: (observed_at, ref).
      expect(seen).toEqual([...seen].sort());
    } finally { db.$client.close(); }
  });

  test("replaying an already-consumed chunk returns the same rows (idempotent)", () => {
    const db = openDb(":memory:");
    try {
      seedBatches(db, 5);
      const first = readChunk(db, batches, null, 2);
      const replay = readChunk(db, batches, null, 2);
      expect(replay.rows).toEqual(first.rows);
      expect(replay.nextCursor).toEqual(first.nextCursor);
    } finally { db.$client.close(); }
  });

  test("rows inserted between chunks join the walk at their sort position", () => {
    const db = openDb(":memory:");
    try {
      seedBatches(db, 4);
      const first = readChunk(db, batches, null, 2);
      expect(first.nextCursor).not.toBeNull();
      // A later batch slots after the cursor; an earlier one is already behind it.
      saveObservationBatch(db, {
        ref: "batch-late", source_ref: "hongguo", source_revision: 2,
        observed_at: "2026-09-15T09:30:00Z", origin: "fixture", observations: [],
      });
      const second = readChunk(db, batches, first.nextCursor, 10);
      const refs = second.rows.map(r => r.ref);
      expect(refs).toContain("batch-late");
      expect(refs).not.toContain(first.rows[0]!.ref);
      expect(second.nextCursor).toBeNull();
    } finally { db.$client.close(); }
  });

  test("cursor serialization round-trips and rejects corrupt shapes", () => {
    const cursor = ["2026-09-15T08:00:00.000Z", "batch-001"] as const;
    expect(parseCursor(serializeCursor([...cursor]), batches)).toEqual([...cursor]);
    expect(parseCursor(null, batches)).toBeNull();
    const corrupt = ["not-json", "[]", '["only-one"]', '["a","b","c"]', '[1,"b"]', '"string"'];
    for (const json of corrupt) {
      try {
        parseCursor(json, batches);
        throw new Error("expected cursor_invalid for " + json);
      } catch (err) {
        expect((err as MarketStoreError).code).toBe("cursor_invalid");
        expect((err as MarketStoreError).message).toContain("--reset-cursor --confirm-reset");
      }
    }
  });

  test("integer cursor columns must round-trip as numbers", () => {
    const sources = syncTableDef("market_sources");
    const ok = parseCursor(JSON.stringify(["hongguo", 2]), sources);
    expect(ok).toEqual(["hongguo", 2]);
    try {
      parseCursor(JSON.stringify(["hongguo", "2"]), sources);
      throw new Error("expected cursor_invalid");
    } catch (err) {
      expect((err as MarketStoreError).code).toBe("cursor_invalid");
    }
  });

  test("cursorOfRow extracts the cursor columns in order", () => {
    const row = { observed_at: "2026-09-15T08:00:00.000Z", ref: "batch-1", digest: "x" };
    expect(cursorOfRow(row, batches)).toEqual(["2026-09-15T08:00:00.000Z", "batch-1"]);
    expect(() => cursorOfRow({ ref: "b" }, batches)).toThrowError(MarketStoreError);
  });
});
