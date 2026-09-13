import { expect, test } from "bun:test";
import { openDb } from "../../src/db/client.ts";
import { initializeMarket } from "../../src/market/sources.ts";
import { saveObservationBatch } from "../../src/market/repository.ts";
import { analyzeMarket, signalByRef } from "../../src/market/signals.ts";
import { buildMarketBrief, readMarketBrief } from "../../src/market/brief.ts";
import type { MarketObservation } from "../../src/market/domain.ts";
import { marketSignals } from "../../src/db/schema.ts";

// Task 5.1 (source side, S03/S11): one mixed-fault chain — batch replay, a
// source outage day, and late data. The store must never invent rises or
// falls, duplicate observations, or rewrite frozen history.

function observation(ref: string, item: string, day: string, value: number): MarketObservation {
  const prev = new Date(Date.parse(day + "T00:00:00Z") - 86400000).toISOString().slice(0, 10);
  return {
    spec: "radar.market_observation.v1", observation_ref: ref,
    source_ref: "hongguo", source_revision: 1, source_item_id: item,
    source_snapshot_ref: "snapshot-" + ref, observed_at: day + "T08:00:00Z", source_published_at: null,
    market: "unknown", market_evidence_refs: [], locale: "zh", format: "unknown",
    production_method: "unknown", production_evidence_refs: [], title: "Fault fixture " + item,
    topics: ["suspense"], facts: [{ name: "engagement", value, unit: "count", basis: "interval",
      window: { start: prev + "T00:00:00Z", end: day + "T00:00:00Z" }, definition_version: "v1", sample_denominator: null }],
    evidence_refs: ["evidence-" + ref], collection_run_ref: "run-fault", origin: "fixture",
  };
}

function day(db: ReturnType<typeof openDb>, dayIso: string, value: number) {
  const receipt = saveObservationBatch(db, { ref: "fault-" + dayIso, source_ref: "hongguo", source_revision: 1,
    observed_at: dayIso + "T08:00:00Z", origin: "fixture",
    observations: [observation("o-" + dayIso, "w1", dayIso, value)] });
  analyzeMarket(db, dayIso + "T00:00:00Z", new Date(Date.parse(dayIso + "T00:00:00Z") + 86400000).toISOString().slice(0, 10) + "T00:00:00Z");
  return receipt;
}

test("batch replay, outage day and late data stay honest end to end", () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    // Day 1 and day 2 collected and analyzed normally.
    const d1 = day(db, "2026-09-10", 100);
    day(db, "2026-09-11", 130);
    const headAfterDay2 = signalByRef(db, db.select().from(marketSignals).all()
      .map(r => r.payload).find(s => s.claim_kind === "metric_changed")!.signal_ref)!;
    expect(headAfterDay2.observed_at).toBe("2026-09-11T08:00:00.000Z");

    // 1. Replaying the same batch creates nothing new (no duplicate counts).
    const replay = saveObservationBatch(db, { ref: "fault-2026-09-10", source_ref: "hongguo", source_revision: 1,
      observed_at: "2026-09-10T08:00:00Z", origin: "fixture",
      observations: [observation("o-2026-09-10", "w1", "2026-09-10", 100)] });
    expect(replay.reused).toBe(true);
    expect(replay.observation_refs).toEqual(d1.observation_refs);
    analyzeMarket(db, "2026-09-10T00:00:00Z", "2026-09-11T00:00:00Z");
    expect(signalByRef(db, headAfterDay2.signal_ref)!.revision).toBe(headAfterDay2.revision);

    // 2. Outage day (2026-09-12 missing): the day-3 brief freezes honest and
    // empty/degraded — no fabricated movement for the missing day.
    buildMarketBrief(db, "2026-09-12T00:00:00Z", "2026-09-13T00:00:00Z", new Date("2026-09-13T09:00:00Z"));
    const outageBrief = readMarketBrief(db);
    expect(outageBrief.status !== "ready").toBe(true);
    expect(outageBrief.main).toEqual([]);
    expect(signalByRef(db, headAfterDay2.signal_ref)!.revision).toBe(headAfterDay2.revision);

    // 3. Day 3 resumes collection (150) and, separately, the outage day's
    // batch finally arrives with its OWN past timestamp (2026-09-12T08). The
    // late row ingests independently and must not rewrite the newer head.
    saveObservationBatch(db, { ref: "fault-2026-09-13", source_ref: "hongguo", source_revision: 1,
      observed_at: "2026-09-13T08:00:00Z", origin: "fixture",
      observations: [observation("o-2026-09-13", "w1", "2026-09-13", 150)] });
    const lateBatch = saveObservationBatch(db, { ref: "fault-late-2026-09-12", source_ref: "hongguo", source_revision: 1,
      observed_at: "2026-09-12T08:00:00Z", origin: "fixture",
      observations: [observation("o-late-2026-09-12", "w1", "2026-09-12", 120),
        observation("o-late-2026-09-12-w2", "w2", "2026-09-12", 200)] });
    expect(lateBatch.reused).toBe(false);
    const day3 = analyzeMarket(db, "2026-09-13T00:00:00Z", "2026-09-14T00:00:00Z");
    expect(day3.skipped.every(s => !s.reasons.includes("historical_signal_revision_preserved"))).toBe(true);
    const lateAnalysis = analyzeMarket(db, "2026-09-12T00:00:00Z", "2026-09-13T00:00:00Z");
    expect(lateAnalysis.skipped.some(s => s.reasons.includes("historical_signal_revision_preserved"))).toBe(true);
    const head = signalByRef(db, headAfterDay2.signal_ref)!;
    expect(head.observed_at).toBe("2026-09-13T08:00:00.000Z");
    // The late outage-day observation becomes the adjacent interval baseline
    // (120 -> 150); the rise is real, not the stale 130 baseline.
    expect((head.comparison as { change: number }).change).toBe(30);
    // The frozen outage brief is immutable; the late observation mints a
    // successor edition for the same window and keeps its original time.
    const successor = buildMarketBrief(db, "2026-09-12T00:00:00Z", "2026-09-13T00:00:00Z", new Date("2026-09-14T09:00:00Z"));
    expect(successor.reused).toBe(false);
    expect(successor.brief.supersedes).toBe(outageBrief.brief_ref);
    expect(readMarketBrief(db, outageBrief.brief_ref).digest).toBe(outageBrief.digest);
    const lateProjection = readMarketBrief(db, successor.brief.brief_ref);
    // The late arrival appears in its own window (as an observed, not yet
    // confirmed, change) and keeps its original observed_at; the newer day-3
    // signal is never pulled into the older window.
    const lateRefs = lateProjection.visible_signal_refs;
    expect(lateRefs.length).toBe(1);
    expect(lateProjection.watching.map(s => s.title)).toContain("Fault fixture w2");
    expect(lateProjection.watching.every(s => s.observed_at === "2026-09-12T08:00:00.000Z")).toBe(true);
  } finally { db.$client.close(); }
});
