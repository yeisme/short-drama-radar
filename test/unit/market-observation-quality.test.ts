import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { openDb } from "../../src/db/client.ts";
import { initializeMarket } from "../../src/market/sources.ts";
import { HONGGUO_ANCHOR_LAYOUT_VERSION, importCatalog } from "../../src/market/catalog.ts";
import { observationQualityForBatch, OBSERVATION_QUALITY_SPEC } from "../../src/market/quality.ts";
import { marketObservationQuality } from "../../src/db/schema.ts";
import { saveObservationBatch, sourceByRef } from "../../src/market/repository.ts";

const fields = () => readFileSync("test/fixtures/market/hongguo-fields.html", "utf8");

test("observe/import persist one quality record per batch and replays reuse it (S09)", async () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    const first = await importCatalog(db, { source: "hongguo", content: fields(), format: "html", observedAt: "2026-09-10T08:00:00Z", origin: "fixture" });
    const record = observationQualityForBatch(db, first.batch_ref)!;
    expect(record.spec).toBe(OBSERVATION_QUALITY_SPEC);
    expect(record.parser_version).toBe(HONGGUO_ANCHOR_LAYOUT_VERSION);
    expect(record.origin).toBe("fixture");
    expect(record.items).toBe(4);
    expect(record.field_coverage.category).toEqual({ present: 4, total: 4 });
    expect(record.field_coverage.episode_count).toEqual({ present: 2, total: 4 });
    expect(record.skipped).toEqual({ foreign_or_unsafe_link: 1, no_work_identity: 1, title_invalid: 0 });
    const replay = await importCatalog(db, { source: "hongguo", content: fields(), format: "html", observedAt: "2026-09-10T08:00:00Z", origin: "fixture" });
    expect(replay.reused).toBe(true);
    expect(db.select().from(marketObservationQuality).all()).toHaveLength(1);
    const manual = await importCatalog(db, { source: "hongguo", content: fields(), format: "html", observedAt: "2026-09-10T20:00:00Z", origin: "manual" });
    expect(observationQualityForBatch(db, manual.batch_ref)?.origin).toBe("manual");
    expect(db.select().from(marketObservationQuality).all()).toHaveLength(2);
    const blob = JSON.stringify(db.select().from(marketObservationQuality).all());
    expect(blob).not.toContain("<");
    expect(blob).not.toContain("cookie");
    expect(blob).not.toContain("/tmp");
  } finally { db.$client.close(); }
});

test("historical batches without a quality row are not backfilled on later writes", () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    const source = sourceByRef(db, "hongguo")!;
    saveObservationBatch(db, {
      ref: "legacy-batch", source_ref: "hongguo", source_revision: source.revision,
      observed_at: "2026-09-01T08:00:00Z", origin: "manual", observations: [],
    });
    expect(observationQualityForBatch(db, "legacy-batch")).toBeNull();
    expect(db.select().from(marketObservationQuality).all()).toHaveLength(0);
  } finally { db.$client.close(); }
});
