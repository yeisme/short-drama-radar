import { expect, test } from "bun:test";
import { openDb } from "../../src/db/client.ts";
import { initializeMarket } from "../../src/market/sources.ts";
import { saveObservationBatch, saveSource, sourceByRef } from "../../src/market/repository.ts";
import { marketEvidence } from "../../src/db/schema.ts";
import { recordSamplingCheck, registerSamplingPlan } from "../../src/market/sampling.ts";
import { qualificationReport, sourceGaps, recordQualification, qualificationRecord } from "../../src/market/qualification.ts";

test("fixture/manual history cannot satisfy live day or freshness gates", () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    for (let day = 4; day <= 10; day++) {
      for (const hour of ["00", "12"]) {
        saveObservationBatch(db, { ref: "batch-" + day + "-" + hour,
          source_ref: "hongguo", source_revision: 1, origin: day % 2 ? "manual" : "fixture",
          observed_at: "2026-09-" + String(day).padStart(2, "0") + "T" + hour + ":00:00Z",
          observations: [] });
      }
    }
    const report = qualificationReport(db, "hongguo", new Date("2026-09-11T08:00:00Z"));
    expect(report.qualified).toBe(false);
    expect(report.health).toBe("unavailable");
    expect(report.days.every(day => day.observations === 0)).toBe(true);
    expect(report.sample_batches.manual + report.sample_batches.fixture).toBe(14);
    const gaps = sourceGaps(db, new Date("2026-09-11T08:00:00Z"));
    expect(gaps.sources).toHaveLength(18);
    expect(gaps.markets.every(m => m.status === "coverage_unverified")).toBe(true);
  } finally { db.$client.close(); }
});

test("qualification records freeze rejected decisions without promoting or overwriting source revisions", () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    const now = new Date("2026-09-11T08:00:00Z");
    const first = recordQualification(db, "hongguo", 1, now);
    expect(first.record.report.qualified).toBe(false);
    expect(first.record.report.reasons).toContain("sampling_plan_not_preregistered");
    expect(recordQualification(db, "hongguo", 1, now).reused).toBe(true);
    const original = sourceByRef(db, "hongguo")!;
    expect(original.readiness).toBe("planned");
    saveSource(db, { ...original, revision: 2, sampling_scope: "Updated fixed sample" }, 1);
    expect(() => recordQualification(db, "hongguo", 1, now)).toThrow("current source revision");
    const second = recordQualification(db, "hongguo", 2, now);
    expect(second.record.record_ref).not.toBe(first.record.record_ref);
    expect(qualificationRecord(db, first.record.record_ref)).toEqual(first.record);
    expect(second.record.report.source_revision).toBe(2);
    expect(() => qualificationRecord(db, "missing")).toThrow("does not exist");
  } finally { db.$client.close(); }
});

test("synthetic reviewed live receipts qualify only with seven fixed complete sampling plans", () => {
  const db = openDb(":memory:");
  const now = new Date("2026-09-11T08:00:00Z");
  try {
    initializeMarket(db);
    // Synthetic database evidence exercises the algorithm; no real source is qualified by this test.
    db.insert(marketEvidence).values({ ref: "sample-review-proof", sourceRef: "hongguo", observedAt: "2026-09-03T00:00:00.000Z",
      payload: { title: "Synthetic reviewed failure example", public_url: "https://example.invalid", source_item_id: "sample", origin: "manual" } }).run();
    saveSource(db, { ...sourceByRef(db, "hongguo")!, revision: 2, readiness: "sample_verified", official_identity_evidence: ["sample-review-proof"] }, 1);
    registerSamplingPlan(db, "hongguo", 2, ["00:00", "12:00"], new Date("2026-09-03T00:00:00Z"));
    for (let day = 4; day <= 10; day++) for (const hour of ["00", "12"]) {
      const ref = `checked-${day}-${hour}`, at = `2026-09-${String(day).padStart(2, "0")}T${hour}:00:00Z`;
      saveObservationBatch(db, { ref, source_ref: "hongguo", source_revision: 2, observed_at: at, origin: "live", observations: [{
        spec: "radar.market_observation.v1", observation_ref: ref, source_ref: "hongguo", source_revision: 2, source_item_id: "sample",
        source_snapshot_ref: ref, observed_at: at, source_published_at: null, market: "unknown", market_evidence_refs: [], locale: "zh",
        format: "unknown", production_method: "unknown", production_evidence_refs: [], title: "Synthetic sample", topics: [], facts: [],
        evidence_refs: ["sample-review-proof"], collection_run_ref: ref, origin: "live",
      }] });
      if (day === 10 && hour === "12") expect(qualificationReport(db, "hongguo", now).qualified).toBe(false);
      const input = { batch_ref: ref, scheduled_at: at, checked_at: at, completeness: "complete" as const,
        stable_ids: true, metric_contract_valid: true, failure_sample_ref: "sample-review-proof" };
      recordSamplingCheck(db, input, now);
      expect(recordSamplingCheck(db, input, now).reused).toBe(true);
      expect(() => recordSamplingCheck(db, { ...input, stable_ids: false }, now)).toThrow("immutable");
    }
    const report = qualificationReport(db, "hongguo", now);
    expect(report.sampling_schedule_verified).toBe(true);
    expect(report.qualified).toBe(true);
    expect(report.reasons).toEqual([]);
    expect(sourceByRef(db, "hongguo")!.readiness).toBe("sample_verified");
  } finally { db.$client.close(); }
});

test("a plan is immutable and late registration cannot retroactively qualify past observations", () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    const now = new Date("2026-09-11T08:00:00Z");
    const saved = registerSamplingPlan(db, "hongguo", 1, ["12:00", "00:00"], now);
    expect(saved.plan.utc_slots).toEqual(["00:00", "12:00"]);
    expect(registerSamplingPlan(db, "hongguo", 1, ["00:00", "12:00"], now).reused).toBe(true);
    expect(() => registerSamplingPlan(db, "hongguo", 1, ["01:00", "13:00"], now)).toThrow("new source revision");
    expect(() => registerSamplingPlan(db, "hongguo", 1, ["00:00", "00:00"], now)).toThrow("unique slots");
    expect(() => registerSamplingPlan(db, "hongguo", 1, ["00:00", "25:00"], now)).toThrow("HH:mm");
    expect(() => registerSamplingPlan(db, "hongguo", 2, ["00:00", "12:00"], now)).toThrow("current source revision");
    const report = qualificationReport(db, "hongguo", now);
    expect(report.sampling_plan_preregistered).toBe(false);
    expect(report.reasons).toContain("sampling_plan_not_preregistered");
    expect(report.qualified).toBe(false);
  } finally { db.$client.close(); }
});

test("even seven live days need identity and sampling evidence, while freshness stays independent", () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    for (let day = 4; day <= 10; day++) {
      for (const hour of ["00", "12"]) saveObservationBatch(db, {
        ref: "live-" + day + "-" + hour, source_ref: "hongguo", source_revision: 1,
        observed_at: "2026-09-" + String(day).padStart(2, "0") + "T" + hour + ":00:00Z",
        origin: "live", observations: [],
      });
    }
    const report = qualificationReport(db, "hongguo", new Date("2026-09-11T08:00:00Z"));
    expect(report.days.every(day => day.two_spaced_observations)).toBe(true);
    expect(report.health).toBe("fresh");
    expect(report.qualified).toBe(false);
    expect(report.reasons).toContain("identity_evidence_missing");
    expect(report.reasons).toContain("sampling_schedule_verification_required");
    expect(qualificationReport(db, "hongguo", new Date("2026-09-12T08:00:00Z")).health).toBe("stale");
  } finally { db.$client.close(); }
});
