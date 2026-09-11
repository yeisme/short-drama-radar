import { expect, test } from "bun:test";
import { openDb } from "../../src/db/client.ts";
import { initializeMarket } from "../../src/market/sources.ts";
import { saveObservationBatch } from "../../src/market/repository.ts";
import { analyzeMarket, correctSignal, signalByRef } from "../../src/market/signals.ts";
import { buildMarketBrief, readMarketBrief } from "../../src/market/brief.ts";
import type { MarketObservation } from "../../src/market/domain.ts";
import { marketEvidence, marketSources } from "../../src/db/schema.ts";
import { seedSources } from "../../src/market/sources.ts";

// Two interval observations per work: the later one lands inside the brief
// window, the earlier one is its comparable baseline.
function intervalObservation(input: {
  ref: string; item: string; observedAt: string; start: string; end: string; value: number; topics: string[];
}): MarketObservation {
  return {
    spec: "radar.market_observation.v1", observation_ref: input.ref,
    source_ref: "hongguo", source_revision: 1, source_item_id: input.item,
    source_snapshot_ref: "snapshot-" + input.ref, observed_at: input.observedAt, source_published_at: null,
    market: "unknown", market_evidence_refs: [], locale: "zh", format: "unknown",
    production_method: "unknown", production_evidence_refs: [], title: "Fixture work " + input.item,
    topics: input.topics, facts: [{ name: "engagement", value: input.value, unit: "count", basis: "interval",
      window: { start: input.start, end: input.end }, definition_version: "v1", sample_denominator: null }],
    evidence_refs: ["evidence-" + input.ref], collection_run_ref: "run-brief", origin: "fixture",
  };
}

function seedWorks(db: ReturnType<typeof openDb>, works: Array<{ item: string; topics: string[] }>) {
  const prior = works.map((work, index) => intervalObservation({
    ref: "pb-" + index, item: work.item, observedAt: "2026-09-11T08:00:00Z",
    start: "2026-09-10T00:00:00Z", end: "2026-09-11T00:00:00Z", value: 100, topics: work.topics,
  }));
  const current = works.map((work, index) => intervalObservation({
    ref: "cb-" + index, item: work.item, observedAt: "2026-09-12T08:00:00Z",
    start: "2026-09-11T00:00:00Z", end: "2026-09-12T00:00:00Z", value: 130, topics: work.topics,
  }));
  saveObservationBatch(db, { ref: "brief-prior", source_ref: "hongguo", source_revision: 1,
    observed_at: "2026-09-11T08:00:00Z", origin: "fixture", observations: prior });
  saveObservationBatch(db, { ref: "brief-current", source_ref: "hongguo", source_revision: 1,
    observed_at: "2026-09-12T08:00:00Z", origin: "fixture", observations: current });
}

test("brief projection is bounded, never padded and caps repeated topics", () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    seedWorks(db, [
      { item: "w1", topics: ["revenge"] }, { item: "w2", topics: ["revenge"] },
      { item: "w3", topics: ["suspense"] }, { item: "w4", topics: ["suspense"] },
      { item: "w5", topics: ["fantasy"] }, { item: "w6", topics: ["fantasy"] },
      { item: "w7", topics: ["urban_power"] },
    ]);
    const analysis = analyzeMarket(db, "2026-09-12T00:00:00Z", "2026-09-13T00:00:00Z");
    expect(analysis.created).toBe(7);
    buildMarketBrief(db, "2026-09-12T00:00:00Z", "2026-09-13T00:00:00Z", new Date("2026-09-13T08:00:00Z"));
    const projection = readMarketBrief(db);
    expect(projection.main).toHaveLength(5);
    expect(projection.main.every(s => s.assertion_level === "confirmed")).toBe(true);
    const topicCounts = projection.main.reduce((counts, signal) => {
      const topic = signal.topics[0];
      counts.set(topic, (counts.get(topic) ?? 0) + 1);
      return counts;
    }, new Map<string, number>());
    expect([...topicCounts.values()].every(count => count <= 2)).toBe(true);
    expect(projection.remaining).toBe(2);
    expect(projection.correction_count).toBe(0);
    expect(projection.filtered).toBe(false);
    expect(typeof projection.policy_revision).toBe("string");
  } finally { db.$client.close(); }
});

test("a window with a single valid change is not padded with stale or low-confidence entries", () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    seedWorks(db, [{ item: "only", topics: ["revenge"] }]);
    analyzeMarket(db, "2026-09-12T00:00:00Z", "2026-09-13T00:00:00Z");
    buildMarketBrief(db, "2026-09-12T00:00:00Z", "2026-09-13T00:00:00Z", new Date("2026-09-13T08:00:00Z"));
    const projection = readMarketBrief(db);
    expect(projection.main).toHaveLength(1);
    expect(projection.watching).toEqual([]);
    expect(projection.remaining).toBe(0);
  } finally { db.$client.close(); }
});

test("correction overflow stays discoverable beyond the five-entry cap", () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    seedWorks(db, Array.from({ length: 6 }, (_, i) => ({ item: "c" + i, topics: ["topic" + i] })));
    const analysis = analyzeMarket(db, "2026-09-12T00:00:00Z", "2026-09-13T00:00:00Z");
    for (const created of analysis.signals) {
      const signal = signalByRef(db, created.ref, created.revision)!;
      // Corrections must cite stored evidence available at correction time.
      for (const evidenceRef of signal.evidence_refs) {
        db.insert(marketEvidence).values({ ref: evidenceRef, sourceRef: "hongguo",
          observedAt: "2026-09-12T08:00:00.000Z",
          payload: { title: "Fixture evidence", public_url: "https://example.com", source_item_id: signal.subject_ref, origin: "fixture" },
        }).onConflictDoNothing().run();
      }
      correctSignal(db, { ref: signal.signal_ref, expected_revision: signal.revision,
        reason: "Fixture correction for overflow coverage.", evidence_refs: signal.evidence_refs,
        outcome: "retracted", corrected_at: "2026-09-12T09:00:00Z" });
    }
    buildMarketBrief(db, "2026-09-12T00:00:00Z", "2026-09-13T00:00:00Z", new Date("2026-09-13T08:00:00Z"));
    const projection = readMarketBrief(db);
    expect(projection.main).toHaveLength(5);
    expect(projection.main.every(s => s.claim_kind === "correction")).toBe(true);
    expect(projection.correction_count).toBe(6);
    expect(projection.correction_refs).toHaveLength(6);
    expect(projection.watching).toEqual([]);
  } finally { db.$client.close(); }
});

test("late data rebuilds the same window into a new immutable brief linked by supersedes", () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    seedWorks(db, [{ item: "w1", topics: ["revenge"] }]);
    analyzeMarket(db, "2026-09-12T00:00:00Z", "2026-09-13T00:00:00Z");
    const first = buildMarketBrief(db, "2026-09-12T00:00:00Z", "2026-09-13T00:00:00Z", new Date("2026-09-13T08:00:00Z"));
    expect(first.brief.supersedes).toBeNull();
    // A late observation with its original observed_at inside the frozen
    // window must produce a successor edition, never rewrite the first.
    saveObservationBatch(db, { ref: "brief-late", source_ref: "hongguo", source_revision: 1,
      observed_at: "2026-09-12T10:00:00Z", origin: "fixture", observations: [intervalObservation({
        ref: "late-1", item: "late-work", observedAt: "2026-09-12T10:00:00Z",
        start: "2026-09-11T00:00:00Z", end: "2026-09-12T00:00:00Z", value: 90, topics: ["suspense"],
      })] });
    analyzeMarket(db, "2026-09-12T00:00:00Z", "2026-09-13T00:00:00Z");
    const second = buildMarketBrief(db, "2026-09-12T00:00:00Z", "2026-09-13T00:00:00Z", new Date("2026-09-13T09:00:00Z"));
    expect(second.reused).toBe(false);
    expect(second.brief.brief_ref).not.toBe(first.brief.brief_ref);
    expect(second.brief.supersedes).toBe(first.brief.brief_ref);
    expect(readMarketBrief(db, first.brief.brief_ref).digest).toBe(first.brief.digest);
    expect(readMarketBrief(db, first.brief.brief_ref).visible_signal_refs).toHaveLength(1);
    expect(readMarketBrief(db, second.brief.brief_ref).supersedes).toBe(first.brief.brief_ref);
    // Replaying the same inputs reuses the successor without further churn.
    expect(buildMarketBrief(db, "2026-09-12T00:00:00Z", "2026-09-13T00:00:00Z", new Date("2026-09-13T10:00:00Z")).reused).toBe(true);
  } finally { db.$client.close(); }
});

test("status separates live qualified coverage from fixture or degraded editions", () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    seedWorks(db, [{ item: "w1", topics: ["revenge"] }]);
    analyzeMarket(db, "2026-09-12T00:00:00Z", "2026-09-13T00:00:00Z");
    const fixtureEdition = buildMarketBrief(db, "2026-09-12T00:00:00Z", "2026-09-13T00:00:00Z", new Date("2026-09-13T08:00:00Z"));
    expect(fixtureEdition.brief.status).toBe("degraded");
    // A future qualified source with live observations is the only path to a
    // ready edition; the row is seeded directly because promotion is reserved
    // for the qualification service, which does not promote yet.
    const qualified = structuredClone(seedSources().find(source => source.source_ref === "hongguo")!);
    qualified.revision = 2;
    qualified.readiness = "qualified";
    qualified.official_identity_evidence = ["identity-evidence"];
    db.insert(marketSources).values({ ref: qualified.source_ref, revision: 2, payload: qualified }).run();
    const live = intervalObservation({ ref: "live-1", item: "live-work", observedAt: "2026-09-13T08:00:00Z",
      start: "2026-09-12T00:00:00Z", end: "2026-09-13T00:00:00Z", value: 140, topics: ["revenge"] });
    live.source_revision = 2;
    live.origin = "live";
    saveObservationBatch(db, { ref: "brief-live", source_ref: "hongguo", source_revision: 2,
      observed_at: "2026-09-13T08:00:00Z", origin: "live", observations: [live] });
    // A window holding only live signals from the qualified source is ready;
    // the fixture window above stays degraded by comparison.
    analyzeMarket(db, "2026-09-13T00:00:00Z", "2026-09-14T00:00:00Z");
    const liveEdition = buildMarketBrief(db, "2026-09-13T00:00:00Z", "2026-09-14T00:00:00Z", new Date("2026-09-14T08:00:00Z"));
    expect(liveEdition.brief.status).toBe("ready");
    expect(liveEdition.brief.signals.every(s => s.origin === "live")).toBe(true);
    expect(fixtureEdition.brief.status).toBe("degraded");
    expect(readMarketBrief(db, fixtureEdition.brief.brief_ref).limitations.some(l => /qualification is incomplete/.test(l))).toBe(true);
  } finally { db.$client.close(); }
});
