import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { openDb } from "../../src/db/client.ts";
import { initializeMarket } from "../../src/market/sources.ts";
import { importCatalog } from "../../src/market/catalog.ts";
import { analyzeMarket, correctSignal, restoreSignal, signalByRef } from "../../src/market/signals.ts";
import { buildMarketBrief, marketBriefByRef, readMarketBrief } from "../../src/market/brief.ts";
import { changeReadState, readReader } from "../../src/market/reader.ts";
import { catchUp } from "../../src/market/catchup.ts";
import { saveObservationBatch } from "../../src/market/repository.ts";
import { marketObservations } from "../../src/db/schema.ts";
import { buildMarketReview, readMarketReview } from "../../src/market/review.ts";

test("correction preserves original brief, becomes unread again and leads the next brief", async () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    await importCatalog(db, { source: "dramabox", content: readFileSync("test/fixtures/market/dramabox.md", "utf8"),
      format: "markdown", observedAt: "2026-09-10T08:00:00Z", origin: "fixture" });
    const result = analyzeMarket(db, "2026-09-10T00:00:00Z", "2026-09-11T00:00:00Z");
    const original = signalByRef(db, result.signals[0].ref)!;
    const oldBrief = buildMarketBrief(db, "2026-09-10T00:00:00Z", "2026-09-11T00:00:00Z", new Date("2026-09-11T08:00:00Z")).brief;
    const reader = readReader(db);
    changeReadState(db, { action: "mark", idempotency_key: "original-read", expected_revision: reader.revision,
      policy_revision: reader.policy_revision, signals: [{ ref: original.signal_ref, revision: 1 }] });
    const request = { ref: original.signal_ref, expected_revision: 1,
      reason: "Catalog listing cannot establish a premiere date.", evidence_refs: original.evidence_refs,
      outcome: "retracted" as const, corrected_at: "2026-09-11T09:00:00Z" };
    expect(correctSignal(db, request).signal.revision).toBe(2);
    expect(correctSignal(db, request).reused).toBe(true);
    const replay = analyzeMarket(db, "2026-09-10T00:00:00Z", "2026-09-11T00:00:00Z");
    expect(replay.signals.some(s => s.ref === original.signal_ref)).toBe(false);
    expect(replay.skipped.some(s => s.reasons.includes("correction_review_required"))).toBe(true);
    expect(signalByRef(db, original.signal_ref)?.lifecycle).toBe("retracted");
    expect(signalByRef(db, original.signal_ref, 1)).toEqual(original);
    expect(marketBriefByRef(db, oldBrief.brief_ref)).toEqual(oldBrief);
    expect(catchUp(db, { now: new Date("2026-09-12T10:00:00Z") }).signals.find(s => s.signal_ref === original.signal_ref)?.revision).toBe(2);
    const next = buildMarketBrief(db, "2026-09-11T00:00:00Z", "2026-09-12T00:00:00Z", new Date("2026-09-12T10:00:00Z")).brief;
    expect(readMarketBrief(db, next.brief_ref).main[0].claim_kind).toBe("correction");
    expect(readMarketBrief(db, next.brief_ref).correction_count).toBe(1);
    expect(() => correctSignal(db, { ...request, evidence_refs: ["missing"] })).toThrow("must exist");
    expect(() => correctSignal(db, { ...request, reason: "Different correction" })).toThrow("Signal changed");
  } finally { db.$client.close(); }
});

test("new metric observations cannot silently reactivate an explicitly withdrawn claim", async () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    await importCatalog(db, { source: "dramabox", content: readFileSync("test/fixtures/market/dramabox.md", "utf8"),
      format: "markdown", observedAt: "2026-09-01T08:00:00Z", origin: "fixture" });
    const sample = db.select().from(marketObservations).limit(1).get()!.payload;
    for (const [day, value] of [[2, 10], [3, 30], [4, 35], [5, 65]]) {
      const at = `2026-09-0${day}T08:00:00Z`;
      saveObservationBatch(db, { ref: "metric-batch-" + day, source_ref: "dramabox", source_revision: 1,
        observed_at: at, origin: "fixture", observations: [{ ...sample, observation_ref: "metric-observation-" + day,
          observed_at: at, source_item_id: "metric-work", facts: [{ name: "views", value, unit: "count",
            basis: "cumulative", window: null, definition_version: "v1", sample_denominator: null }] }] });
    }
    const result = analyzeMarket(db, "2026-09-02T00:00:00Z", "2026-09-05T00:00:00Z");
    const metric = result.signals.map(s => signalByRef(db, s.ref)!).find(s => s.claim_kind === "metric_changed")!;
    const corrected = correctSignal(db, { ref: metric.signal_ref, expected_revision: metric.revision,
      evidence_refs: sample.evidence_refs, reason: "Fixture metric claim withdrawn pending review.",
      outcome: "retracted", corrected_at: "2026-09-04T09:00:00Z" }).signal;
    const next = analyzeMarket(db, "2026-09-05T00:00:00Z", "2026-09-06T00:00:00Z");
    expect(next.created).toBe(0);
    expect(next.skipped).toContainEqual({ observation_ref: "metric-observation-5", metric: "views", reasons: ["correction_review_required"] });
    expect(signalByRef(db, metric.signal_ref)).toEqual(corrected);
    expect(signalByRef(db, metric.signal_ref, 1)?.claim_kind).toBe("metric_changed");
    const reviewStart = "2026-09-04T00:00:00Z", reviewEnd = "2026-09-04T08:30:00Z";
    const withdrawnReview = buildMarketReview(db, reviewStart, reviewEnd, "2026-09-05T08:30:00Z").review;
    expect(withdrawnReview.entries.find(e => e.original.signal_ref === metric.signal_ref)?.outcome).toBe("retracted");
    const request = { ref: metric.signal_ref, expected_revision: corrected.revision,
      observation_ref: "metric-observation-5", reason: "New fixture evidence explicitly reviewed.", reviewed_at: "2026-09-05T09:00:00Z" };
    expect(() => restoreSignal(db, { ...request, observation_ref: "metric-observation-4" })).toThrow("newer observation");
    expect(() => restoreSignal(db, { ...request, reviewed_at: "2026-09-05T07:00:00Z" })).toThrow("available by review time");
    const restored = restoreSignal(db, request);
    expect(restored.signal.revision).toBe(3);
    expect(restored.signal.lifecycle).toBe("active");
    expect(restored.signal.corrects_revision).toBe(2);
    expect(restored.signal.comparison).toMatchObject({ before: 5, after: 30 });
    expect(restoreSignal(db, request).reused).toBe(true);
    expect(() => restoreSignal(db, { ...request, reason: "Changed review" })).toThrow("Signal changed");
    expect(signalByRef(db, metric.signal_ref, 2)).toEqual(corrected);
    expect(catchUp(db, { now: new Date("2026-09-06T10:00:00Z") }).signals.find(s => s.signal_ref === metric.signal_ref)?.revision).toBe(3);
    const restoredReview = buildMarketReview(db, reviewStart, reviewEnd, "2026-09-05T10:00:00Z").review;
    const reviewed = restoredReview.entries.find(e => e.original.signal_ref === metric.signal_ref)!;
    expect(reviewed.outcome).toBe("sustained");
    expect(reviewed.followup?.revision).toBe(3);
    expect(readMarketReview(db, withdrawnReview.review_ref).entries.find(e => e.original.signal_ref === metric.signal_ref)?.outcome).toBe("retracted");
    expect(buildMarketReview(db, reviewStart, reviewEnd, "2026-09-05T08:30:00Z").review).toEqual(withdrawnReview);
  } finally { db.$client.close(); }
});
