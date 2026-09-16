import { expect, test } from "bun:test";
import { openDb } from "../../src/db/client.ts";
import { initializeMarket } from "../../src/market/sources.ts";
import { persistObservationQuality, QUALITY_REGRESSION_THRESHOLD } from "../../src/market/quality.ts";
import { saveObservationBatch, sourceByRef } from "../../src/market/repository.ts";
import { buildHealthReport } from "../../src/pipeline/health.ts";
import type { MarketObservation } from "../../src/market/domain.ts";

function observation(ref: string, at: string): MarketObservation {
  return {
    spec: "radar.market_observation.v1", observation_ref: ref,
    source_ref: "hongguo", source_revision: 1, source_item_id: ref,
    source_snapshot_ref: "snap-" + ref, observed_at: at, source_published_at: null,
    market: "global", market_evidence_refs: [], locale: "zh", format: "unknown",
    production_method: "unknown", production_evidence_refs: [], title: "t",
    topics: [], facts: [], evidence_refs: ["evidence-" + ref], collection_run_ref: "run-" + ref, origin: "manual",
  };
}

function seedBatch(db: ReturnType<typeof openDb>, ref: string, at: string, coverage: { present: number; total: number }) {
  const source = sourceByRef(db, "hongguo")!;
  saveObservationBatch(db, {
    ref, source_ref: "hongguo", source_revision: source.revision, observed_at: at, origin: "manual",
    observations: [observation("obs-" + ref, at)],
  });
  persistObservationQuality(db, {
    batch_ref: ref, source, observed_at: at, origin: "manual", parser_version: "catalog-links.v1",
    items: coverage.total, field_coverage: { title: coverage },
    skipped: { foreign_or_unsafe_link: 0, no_work_identity: 0, title_invalid: 0 },
  });
}

test("health market quality section flags coverage regression without failing the report (S11)", () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    seedBatch(db, "prev-high", "2026-08-25T08:00:00Z", { present: 10, total: 10 });
    seedBatch(db, "curr-low", "2026-09-10T08:00:00Z", { present: 5, total: 10 });
    const report = buildHealthReport(db, 14, new Date("2026-09-16T00:00:00Z"));
    expect(report.marketObservationQuality.threshold).toBe(QUALITY_REGRESSION_THRESHOLD);
    const hongguo = report.marketObservationQuality.sources.find(s => s.source_ref === "hongguo")!;
    expect(hongguo.regression_flagged).toBe(true);
    expect(hongguo.quality_unavailable).toBe(false);
    expect(hongguo.coverage_last).toBe(0.5);
    expect(hongguo.previous_window_coverage).toBe(1);
  } finally { db.$client.close(); }
});

test("batches without quality records are quality_unavailable and never treated as zero coverage (S11)", () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    const source = sourceByRef(db, "hongguo")!;
    saveObservationBatch(db, {
      ref: "legacy-no-quality", source_ref: "hongguo", source_revision: source.revision,
      observed_at: "2026-09-10T08:00:00Z", origin: "manual", observations: [],
    });
    const report = buildHealthReport(db, 14, new Date("2026-09-16T00:00:00Z"));
    const hongguo = report.marketObservationQuality.sources.find(s => s.source_ref === "hongguo")!;
    expect(hongguo.quality_unavailable).toBe(true);
    expect(hongguo.missing_records).toBe(1);
    expect(hongguo.coverage_average).toBeNull();
    expect(hongguo.regression_flagged).toBe(false);
  } finally { db.$client.close(); }
});
