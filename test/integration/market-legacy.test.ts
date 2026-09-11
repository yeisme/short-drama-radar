import { expect, test } from "bun:test";
import { openDb } from "../../src/db/client.ts";
import { rawSnapshots, marketObservations, marketBatches } from "../../src/db/schema.ts";
import { importLegacyRun } from "../../src/market/legacy.ts";

test("legacy bridge preserves source, time, metrics and references without claiming live provenance", () => {
  const db = openDb(":memory:");
  try {
    db.insert(rawSnapshots).values({
      runId: "collect-2026-09-10", platform: "xiaohongshu", layer: 1, source: "xhs-backend",
      contentId: "abc123", title: "旧快照", metricsJson: JSON.stringify({ liked_count: 50, like_delta: 5, play_count: 999 }),
      fetchedAt: "2026-09-10T08:00:00Z",
    }).run();
    const original = db.select().from(rawSnapshots).all();
    const first = importLegacyRun(db, "collect-2026-09-10");
    const repeat = importLegacyRun(db, "collect-2026-09-10");
    expect(first.imported).toBe(1);
    expect(repeat.receipts[0].reused).toBe(true);
    const item = db.select().from(marketObservations).get()!.payload;
    expect(item.origin).toBe("manual");
    expect(item.market).toBe("unknown");
    expect(item.observed_at).toBe("2026-09-10T08:00:00.000Z");
    expect(item.source_snapshot_ref).toBe("legacy-snapshot-" + original[0].id);
    expect(item.facts.map(f => f.name)).toEqual(["liked_count"]);
    expect(db.select().from(rawSnapshots).all()).toEqual(original);
    expect(db.select().from(marketObservations).all()).toHaveLength(1);
  } finally { db.$client.close(); }
});

test("malformed legacy rows fail atomically and do not leave partial observations", () => {
  const db = openDb(":memory:");
  try {
    for (const [contentId, metricsJson] of [["valid", "{}"], ["bad", "{broken"]]) {
      db.insert(rawSnapshots).values({
        runId: "broken-run", platform: "douyin", layer: 0, source: "firecrawl",
        contentId, title: "Sample", metricsJson, fetchedAt: "2026-09-10T08:00:00Z",
      }).run();
    }
    expect(() => importLegacyRun(db, "broken-run")).toThrow("valid JSON");
    expect(db.select().from(marketObservations).all()).toEqual([]);
    expect(db.select().from(marketBatches).all()).toEqual([]);
    expect(() => importLegacyRun(db, "missing")).toThrow("No legacy snapshots");
  } finally { db.$client.close(); }
});
