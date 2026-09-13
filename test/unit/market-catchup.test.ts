import { expect, test } from "bun:test";
import { openDb } from "../../src/db/client.ts";
import { initializeMarket } from "../../src/market/sources.ts";
import { saveObservationBatch } from "../../src/market/repository.ts";
import { analyzeMarket, correctSignal } from "../../src/market/signals.ts";
import { catchUp } from "../../src/market/catchup.ts";
import { changeReadState, isRead, readReader } from "../../src/market/reader.ts";
import { marketReadPolicy } from "../../src/market/policy.ts";
import { marketEvidence, marketReadMarks } from "../../src/db/schema.ts";
import type { MarketObservation } from "../../src/market/domain.ts";

// S12: catch-up is an explicit, bounded, cursor-stable projection of unread
// signal revisions. Three idle days show nothing old; corrections re-enter
// unread; beyond 30 days is stated, not silently truncated.

function observation(ref: string, item: string, observedAt: string, start: string, end: string, value: number): MarketObservation {
  return {
    spec: "radar.market_observation.v1", observation_ref: ref,
    source_ref: "hongguo", source_revision: 1, source_item_id: item,
    source_snapshot_ref: "snapshot-" + ref, observed_at: observedAt, source_published_at: null,
    market: "unknown", market_evidence_refs: [], locale: "zh", format: "unknown",
    production_method: "unknown", production_evidence_refs: [], title: "Catchup fixture " + item,
    topics: ["suspense"], facts: [{ name: "engagement", value, unit: "count", basis: "interval",
      window: { start, end }, definition_version: "v1", sample_denominator: null }],
    evidence_refs: ["evidence-" + ref], collection_run_ref: "run-catchup", origin: "fixture",
  };
}

function seedWorks(db: ReturnType<typeof openDb>, works: string[]) {
  const observations = works.flatMap((item, index) => [
    observation("p-" + index, item, "2026-09-11T08:00:00Z", "2026-09-10T00:00:00Z", "2026-09-11T00:00:00Z", 100),
    observation("c-" + index, item, "2026-09-12T08:00:00Z", "2026-09-11T00:00:00Z", "2026-09-12T00:00:00Z", 130),
  ]);
  saveObservationBatch(db, { ref: "catchup-prior", source_ref: "hongguo", source_revision: 1,
    observed_at: "2026-09-11T08:00:00Z", origin: "fixture", observations: observations.filter(o => o.observed_at === "2026-09-11T08:00:00Z") });
  saveObservationBatch(db, { ref: "catchup-current", source_ref: "hongguo", source_revision: 1,
    observed_at: "2026-09-12T08:00:00Z", origin: "fixture", observations: observations.filter(o => o.observed_at === "2026-09-12T08:00:00Z") });
  return analyzeMarket(db, "2026-09-12T00:00:00Z", "2026-09-13T00:00:00Z");
}

const NOW = new Date("2026-09-14T08:00:00Z");

test("pagination is stable at 20 items and the second page has no duplicates", () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    seedWorks(db, Array.from({ length: 25 }, (_, i) => "w" + i));
    const reader = readReader(db), policy = marketReadPolicy(db);
    const page1 = catchUp(db, { now: NOW });
    expect(page1.signals).toHaveLength(20);
    expect(page1.next_cursor).toBeTruthy();
    expect(page1.window.start).toBe(new Date(NOW.getTime() - 30 * 86400000).toISOString());
    const page2 = catchUp(db, { cursor: page1.next_cursor!, now: NOW });
    expect(page2.signals).toHaveLength(5);
    const refs1 = new Set(page1.signals.map(s => s.signal_ref));
    expect(page2.signals.every(s => !refs1.has(s.signal_ref))).toBe(true);
    // Reading never mutates state: no marks, no reader bump.
    expect(readReader(db)).toEqual(reader);
    expect(db.select().from(marketReadMarks).all()).toEqual([]);
    // Explicit marking of exactly the visible page keeps the rest unread.
    changeReadState(db, { action: "mark", idempotency_key: "catchup-mark-1",
      expected_revision: reader.revision, policy_revision: policy.policy_revision,
      signals: page1.signals.map(s => ({ ref: s.signal_ref, revision: s.revision })) });
    const fresh = catchUp(db, { now: NOW });
    expect(fresh.signals).toHaveLength(5);
    expect(fresh.signals.every(s => !refs1.has(s.signal_ref))).toBe(true);
  } finally { db.$client.close(); }
});

test("corrections re-enter unread; three idle days show nothing old", () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    const analysis = seedWorks(db, ["w0", "w1"]);
    const target = analysis.signals[0]!;
    const reader = readReader(db), policy = marketReadPolicy(db);
    changeReadState(db, { action: "mark", idempotency_key: "mark-all-1",
      expected_revision: reader.revision, policy_revision: policy.policy_revision,
      signals: analysis.signals.map(s => ({ ref: s.ref, revision: 1 })) });
    expect(catchUp(db, { now: new Date("2026-09-13T08:00:00Z") }).signals).toEqual([]);
    // Corrections must cite stored evidence; seed one row like import-catalog.
    db.insert(marketEvidence).values({ ref: "evidence-correction", sourceRef: "hongguo",
      observedAt: "2026-09-12T08:00:00Z",
      payload: { title: "Revising catalog snapshot", public_url: "", source_item_id: target.ref, origin: "fixture" } }).run();
    correctSignal(db, { ref: target.ref, expected_revision: 1, reason: "superseded evidence",
      evidence_refs: ["evidence-correction"], outcome: "retracted", corrected_at: "2026-09-13T09:00:00Z" });
    const after = catchUp(db, { now: NOW });
    expect(after.signals.map(s => s.signal_ref)).toEqual([target.ref]);
    expect(after.signals[0]!.revision).toBe(2);
    expect(after.signals[0]!.claim_kind).toBe("correction");
    // The previously read revision stays read; only the correction is new.
    expect(isRead(db, { ref: target.ref, revision: 1 })).toBe(true);
    expect(isRead(db, { ref: target.ref, revision: 2 })).toBe(false);
  } finally { db.$client.close(); }
});

test("30-day boundary is explicit and older history is not silently dropped", () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    // One work observed far beyond the 30-day window plus one recent work.
    saveObservationBatch(db, { ref: "old-prior", source_ref: "hongguo", source_revision: 1,
      observed_at: "2026-08-01T08:00:00Z", origin: "fixture", observations: [
        observation("old-p", "old-work", "2026-08-01T08:00:00Z", "2026-07-31T00:00:00Z", "2026-08-01T00:00:00Z", 100)] });
    saveObservationBatch(db, { ref: "old-late", source_ref: "hongguo", source_revision: 1,
      observed_at: "2026-08-02T08:00:00Z", origin: "fixture", observations: [
        observation("old-c", "old-work", "2026-08-02T08:00:00Z", "2026-08-01T00:00:00Z", "2026-08-02T00:00:00Z", 130)] });
    seedWorks(db, ["recent-work"]);
    const result = catchUp(db, { now: NOW });
    expect(result.signals.every(s => s.title !== "Catchup fixture old-work")).toBe(true);
    expect(result.history_limited).toBe(true);
    expect(result.limitations.join(" ")).toContain("30 days");
  } finally { db.$client.close(); }
});

test("cursors are validated, bounded and invalidated by concurrent writes", () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    seedWorks(db, Array.from({ length: 25 }, (_, i) => "w" + i));
    const page1 = catchUp(db, { now: NOW });
    // Tampered and malformed cursors never widen the window.
    expect(() => catchUp(db, { cursor: "!!!not-a-cursor", now: NOW })).toThrow("invalid");
    const widened = JSON.parse(Buffer.from(page1.next_cursor!, "base64url").toString());
    Object.assign(widened, { start: "2026-09-13T00:00:00Z", end: "2026-09-15T00:00:00Z", time: "2026-09-13T12:00:00Z" });
    expect(() => catchUp(db, { cursor: Buffer.from(JSON.stringify(widened)).toString("base64url"), now: NOW })).toThrow("cannot end in the future");
    // A new signal between pages changes the generation: restart, never skip.
    saveObservationBatch(db, { ref: "catchup-late", source_ref: "hongguo", source_revision: 1,
      observed_at: "2026-09-13T08:00:00Z", origin: "fixture", observations: [
        observation("late-c", "late-work", "2026-09-13T08:00:00Z", "2026-09-12T00:00:00Z", "2026-09-13T00:00:00Z", 120)] });
    analyzeMarket(db, "2026-09-13T00:00:00Z", "2026-09-14T00:00:00Z");
    expect(() => catchUp(db, { cursor: page1.next_cursor!, now: NOW })).toThrow("restart catch-up");
    // A fresh read (no cursor) must include the late work's signals (newly
    // observed + metric change), never silently skip them.
    const restarted = catchUp(db, { now: NOW, limit: 100 });
    expect(restarted.signals.filter(s => s.title === "Catchup fixture late-work")).toHaveLength(1);
    expect(restarted.signals.length).toBe(27);
    expect(restarted.signals.some(s => s.title === "Catchup fixture late-work")).toBe(true);
  } finally { db.$client.close(); }
});
