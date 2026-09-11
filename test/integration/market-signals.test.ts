import { expect, test } from "bun:test";
import { openDb } from "../../src/db/client.ts";
import { initializeMarket, updateSettings } from "../../src/market/sources.ts";
import { saveObservationBatch } from "../../src/market/repository.ts";
import { analyzeMarket, signalByRef } from "../../src/market/signals.ts";
import { marketCommand } from "../../src/market/cli.ts";
import { marketObservations } from "../../src/db/schema.ts";
import type { MarketObservation } from "../../src/market/domain.ts";

test("analysis persists stable signals, reuses identical inputs and binds old revisions", async () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    for (const [day, total] of [[10, 100], [11, 120], [12, 125], [13, 145]]) {
      const observedAt = "2026-09-" + day + "T00:00:00Z";
      const item: MarketObservation = {
        spec: "radar.market_observation.v1", observation_ref: "obs-" + day,
        source_ref: "hongguo", source_revision: 1, source_item_id: "work-1",
        source_snapshot_ref: "snapshot-" + day, observed_at: observedAt, source_published_at: null,
        market: "unknown", market_evidence_refs: [], locale: "zh", format: "unknown",
        production_method: "unknown", production_evidence_refs: [], title: "Sample", topics: [],
        facts: [{ name: "views", value: total, unit: "count", basis: "cumulative", window: null, definition_version: "v1", sample_denominator: null }],
        evidence_refs: ["snapshot-" + day], collection_run_ref: "run-" + day, origin: "fixture",
      };
      saveObservationBatch(db, { ref: "batch-" + day, source_ref: "hongguo", source_revision: 1, observed_at: observedAt, origin: "fixture", observations: [item] });
    }
    const first = analyzeMarket(db, "2026-09-10T00:00:00Z", "2026-09-13T00:00:00Z");
    expect(first.created).toBe(2); // First observation and one comparable change.
    expect(first.skipped).toHaveLength(2);
    const metric = first.signals.map(s => signalByRef(db, s.ref, s.revision)!).find(s => s.claim_kind === "metric_changed")!;
    expect(metric.comparison).toMatchObject({ before: 20, after: 5, percent_change: -75 });
    expect(analyzeMarket(db, "2026-09-10T00:00:00Z", "2026-09-13T00:00:00Z").created).toBe(0);
    const next = analyzeMarket(db, "2026-09-13T00:00:00Z", "2026-09-14T00:00:00Z");
    expect(next.signals).toEqual([{ ref: metric.signal_ref, revision: 2 }]);
    expect(signalByRef(db, metric.signal_ref, 1)?.comparison).toMatchObject({ after: 5 });
    expect(signalByRef(db, metric.signal_ref)?.comparison).toMatchObject({ after: 20 });
    expect(signalByRef(db, metric.signal_ref, 99)).toBeNull();
    updateSettings(db, 1, { blocked_topics: ["taboo"] });
    await expect(marketCommand(["market", "signal", "show"], new Map([["signal", [metric.signal_ref]]]), db)).rejects.toThrow("not been classified");
  } finally { db.$client.close(); }
});

// A late-arriving observation with an older observed_at than the signal head
// must get its own distinct outcome and never rewrite the newer revision.
test("late-arriving batches stay independent and never rewrite newer signals", () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    const engagement = (ref: string, observedAt: string, windowStart: string, windowEnd: string, value: number): MarketObservation => ({
      spec: "radar.market_observation.v1", observation_ref: ref,
      source_ref: "hongguo", source_revision: 1, source_item_id: "work-late",
      source_snapshot_ref: "snapshot-" + ref, observed_at: observedAt, source_published_at: null,
      market: "unknown", market_evidence_refs: [], locale: "zh", format: "unknown",
      production_method: "unknown", production_evidence_refs: [], title: "Late sample", topics: [],
      facts: [{ name: "engagement", value, unit: "count", basis: "interval",
        window: { start: windowStart, end: windowEnd }, definition_version: "v1", sample_denominator: null }],
      evidence_refs: ["evidence-" + ref], collection_run_ref: "run-late", origin: "fixture",
    });
    const save = (ref: string, observedAt: string, windowStart: string, windowEnd: string, value: number) =>
      saveObservationBatch(db, { ref: "batch-" + ref, source_ref: "hongguo", source_revision: 1,
        observed_at: observedAt, origin: "fixture", observations: [engagement(ref, observedAt, windowStart, windowEnd, value)] });
    save("a", "2026-09-11T00:00:00Z", "2026-09-09T00:00:00Z", "2026-09-10T00:00:00Z", 100);
    save("b", "2026-09-12T00:00:00Z", "2026-09-10T00:00:00Z", "2026-09-11T00:00:00Z", 120);
    const first = analyzeMarket(db, "2026-09-10T00:00:00Z", "2026-09-13T00:00:00Z");
    const metric = first.signals.map(s => signalByRef(db, s.ref, s.revision)!).find(s => s.claim_kind === "metric_changed")!;
    const head = signalByRef(db, metric.signal_ref)!;
    expect(head.observed_at).toBe("2026-09-12T00:00:00.000Z");
    // The late batch lands between the two forward observations with its own
    // comparable interval; the older observed_at keeps it out of the head.
    save("late", "2026-09-11T12:00:00Z", "2026-09-10T00:00:00Z", "2026-09-11T00:00:00Z", 150);
    const replay = analyzeMarket(db, "2026-09-10T00:00:00Z", "2026-09-13T00:00:00Z");
    expect(replay.created).toBe(0);
    expect(replay.skipped).toContainEqual({ observation_ref: "late", metric: "engagement",
      reasons: ["historical_signal_revision_preserved"] });
    expect(signalByRef(db, metric.signal_ref)).toEqual(head);
    expect(db.select().from(marketObservations).all().map(row => row.ref)).toContain("late");
  } finally { db.$client.close(); }
});
