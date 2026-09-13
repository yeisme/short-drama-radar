import { expect, test } from "bun:test";
import { openDb } from "../../src/db/client.ts";
import { initializeMarket } from "../../src/market/sources.ts";
import { saveObservationBatch } from "../../src/market/repository.ts";
import { analyzeMarket } from "../../src/market/signals.ts";
import { listWatches, mutateWatch, watchChanges } from "../../src/market/watch.ts";
import { readReader } from "../../src/market/reader.ts";
import { marketReadPolicy } from "../../src/market/policy.ts";
import { marketReadMarks, marketSignals, preferenceFeedback } from "../../src/db/schema.ts";
import type { MarketObservation } from "../../src/market/domain.ts";

// S13/S14: the watch state machine is explicit and idempotent, never touches
// the creation-preference feedback ledger, and an empty change window with
// collection gaps reports source_gap instead of implying no change.

function observation(ref: string, item: string, observedAt: string, start: string, end: string, value: number): MarketObservation {
  return {
    spec: "radar.market_observation.v1", observation_ref: ref,
    source_ref: "hongguo", source_revision: 1, source_item_id: item,
    source_snapshot_ref: "snapshot-" + ref, observed_at: observedAt, source_published_at: null,
    market: "unknown", market_evidence_refs: [], locale: "zh", format: "unknown",
    production_method: "unknown", production_evidence_refs: [], title: "Watch fixture " + item,
    topics: ["revenge"], facts: [{ name: "engagement", value, unit: "count", basis: "interval",
      window: { start, end }, definition_version: "v1", sample_denominator: null }],
    evidence_refs: ["evidence-" + ref], collection_run_ref: "run-watch", origin: "fixture",
  };
}

function prepared() {
  const db = openDb(":memory:");
  initializeMarket(db);
  saveObservationBatch(db, { ref: "watch-base-p", source_ref: "hongguo", source_revision: 1,
    observed_at: "2026-09-11T08:00:00Z", origin: "fixture", observations: [
      observation("wb-p", "w1", "2026-09-11T08:00:00Z", "2026-09-10T00:00:00Z", "2026-09-11T00:00:00Z", 100)] });
  saveObservationBatch(db, { ref: "watch-base-c", source_ref: "hongguo", source_revision: 1,
    observed_at: "2026-09-12T08:00:00Z", origin: "fixture", observations: [
      observation("wb-c", "w1", "2026-09-12T08:00:00Z", "2026-09-11T00:00:00Z", "2026-09-12T00:00:00Z", 130)] });
  analyzeMarket(db, "2026-09-12T00:00:00Z", "2026-09-13T00:00:00Z");
  const subject = db.select().from(marketSignals).all()[0]!.payload.subject_ref;
  return { db, subject };
}

// Every watch mutation bumps the reader revision; callers must re-read.
function args(db: ReturnType<typeof openDb>) {
  return { revision: readReader(db).revision, policy_revision: marketReadPolicy(db).policy_revision };
}

test("four target kinds resolve; invalid refs are rejected without side effects", () => {
  const { db, subject } = prepared();
  try {
    for (const [key, kind, target] of [
      ["add-topic", "topic", "revenge"], ["add-platform", "platform", "hongguo"],
      ["add-market", "market", "CN"], ["add-work", "work", subject],
    ] as const) {
      expect(mutateWatch(db, { ...args(db), action: "add", key, kind, target }).outcome).toBe("success");
    }
    expect(listWatches(db)).toHaveLength(4);
    // Refusals name the concrete problem per target kind.
    const refusals = [
      [{ kind: "topic", target: "not-a-topic" }, "unknown or blocked"],
      [{ kind: "platform", target: "no-such-platform" }, "not registered"],
      [{ kind: "market", target: "XX" }, "not in the observation registry"],
      [{ kind: "work", target: "work-never-observed" }, "has not been observed"],
    ] as const;
    for (const [bad, message] of refusals) {
      expect(() => mutateWatch(db, { ...args(db), action: "add", key: "add-bad-" + bad.target,
        kind: bad.kind, target: bad.target })).toThrow(message);
    }
    // Nothing leaked into the creation preference ledger or read marks.
    expect(db.select().from(preferenceFeedback).all()).toEqual([]);
    expect(db.select().from(marketReadMarks).all()).toEqual([]);
  } finally { db.$client.close(); }
});

test("pause keeps history, resume works, remove preserves records; replays are idempotent", () => {
  const { db } = prepared();
  try {
    const added = mutateWatch(db, { ...args(db), action: "add", key: "add-1", kind: "topic", target: "revenge" });
    const watchRef = added.watch.watch_ref;
    // Idempotent replay reuses the exact original payload (including the
    // reader revision it was signed with), not a freshly read one.
    const pauseInput = { ...args(db), action: "pause" as const, key: "pause-1", watch: watchRef, now: new Date("2026-09-13T00:00:00Z") };
    const paused = mutateWatch(db, pauseInput);
    expect(paused.watch.state).toBe("paused");
    expect(paused.watch.last_paused_at).toBe("2026-09-13T00:00:00.000Z");
    // Same key, same params: exact replay returns the original receipt.
    expect(mutateWatch(db, pauseInput)).toEqual(paused);
    // Same key, different target: refused (key reuse with another payload).
    const other = mutateWatch(db, { ...args(db), action: "add", key: "add-other", kind: "topic", target: "suspense" });
    expect(() => mutateWatch(db, { ...pauseInput, watch: other.watch.watch_ref })).toThrow("different parameters");
    const resumed = mutateWatch(db, { ...args(db), action: "resume", key: "resume-1", watch: watchRef });
    expect(resumed.watch.state).toBe("active");
    expect(resumed.watch.revision).toBeGreaterThan(paused.watch.revision);
    expect(resumed.watch.last_paused_at).toBe(paused.watch.last_paused_at);
    const removed = mutateWatch(db, { ...args(db), action: "remove", key: "remove-1", watch: watchRef });
    expect(removed.watch.state).toBe("removed");
    // Removed watches keep their row (history preserved); transitions out of removed are refused.
    expect(listWatches(db).map(w => w.watch_ref)).toContain(watchRef);
    expect(() => mutateWatch(db, { ...args(db), action: "resume", key: "resume-2", watch: watchRef })).toThrow("restore a removed watch");
    // Watch mutations never write creation feedback.
    expect(db.select().from(preferenceFeedback).all()).toEqual([]);
  } finally { db.$client.close(); }
});

test("pause-period changes are shown after resume; missing collection is a source gap", () => {
  const { db } = prepared();
  try {
    const added = mutateWatch(db, { ...args(db), action: "add", key: "add-p", kind: "topic", target: "revenge" });
    const watchRef = added.watch.watch_ref;
    mutateWatch(db, { ...args(db), action: "pause", key: "pause-p", watch: watchRef, now: new Date("2026-09-12T12:00:00Z") });
    // A batch lands while the watch is paused.
    saveObservationBatch(db, { ref: "watch-during-pause", source_ref: "hongguo", source_revision: 1,
      observed_at: "2026-09-13T08:00:00Z", origin: "fixture", observations: [
        observation("wd-c", "w1", "2026-09-13T08:00:00Z", "2026-09-12T00:00:00Z", "2026-09-13T00:00:00Z", 160)] });
    analyzeMarket(db, "2026-09-13T00:00:00Z", "2026-09-14T00:00:00Z");
    mutateWatch(db, { ...args(db), action: "resume", key: "resume-p", watch: watchRef, now: new Date("2026-09-14T08:00:00Z") });
    const readerBefore = readReader(db);
    // Default window = the pause period; recorded changes during it are visible.
    const changes = watchChanges(db, { watch: watchRef, now: new Date("2026-09-14T08:00:00Z") });
    expect(changes.window.start).toBe("2026-09-12T12:00:00.000Z");
    expect(changes.signals.length).toBeGreaterThan(0);
    expect(changes.signals.some(s => s.observed_at === "2026-09-13T08:00:00.000Z")).toBe(true);
    expect(changes.coverage.find(c => c.source_ref === "hongguo")!.batches_in_window).toBe(1);
    // A window with no batches at all reports source gaps, never "no change".
    const idle = watchChanges(db, { watch: watchRef, since: "2026-09-20T00:00:00Z", until: "2026-09-21T00:00:00Z" });
    expect(idle.signals).toEqual([]);
    expect(idle.source_gaps).toEqual([{ source_ref: "hongguo", reason: "source_gap" }]);
    expect(idle.limitations.join(" ")).toContain("must not be read as no change");
    // Reads never mutate reader state or marks.
    expect(readReader(db)).toEqual(readerBefore);
    expect(db.select().from(marketReadMarks).all()).toEqual([]);
  } finally { db.$client.close(); }
});
