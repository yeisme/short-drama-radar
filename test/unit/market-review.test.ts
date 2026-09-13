import { expect, test } from "bun:test";
import { openDb } from "../../src/db/client.ts";
import { initializeMarket } from "../../src/market/sources.ts";
import { saveObservationBatch } from "../../src/market/repository.ts";
import { analyzeMarket, correctSignal } from "../../src/market/signals.ts";
import { buildMarketReview, readMarketReview } from "../../src/market/review.ts";
import { marketEvidence, marketSignals } from "../../src/db/schema.ts";
import type { MarketObservation } from "../../src/market/domain.ts";

// S16: the weekly review freezes original vs follow-up evidence and reports
// sustained/cooled/retracted/inconclusive. Missing follow-up is inconclusive,
// never a failed prediction, and the cutoff bounds what later evidence counts.

function observation(ref: string, item: string, observedAt: string, start: string, end: string, value: number): MarketObservation {
  return {
    spec: "radar.market_observation.v1", observation_ref: ref,
    source_ref: "hongguo", source_revision: 1, source_item_id: item,
    source_snapshot_ref: "snapshot-" + ref, observed_at: observedAt, source_published_at: null,
    market: "unknown", market_evidence_refs: [], locale: "zh", format: "unknown",
    production_method: "unknown", production_evidence_refs: [], title: "Review fixture " + item,
    topics: ["suspense"], facts: [{ name: "engagement", value, unit: "count", basis: "interval",
      window: { start, end }, definition_version: "v1", sample_denominator: null }],
    evidence_refs: ["evidence-" + ref], collection_run_ref: "run-review", origin: "fixture",
  };
}

function batch(db: ReturnType<typeof openDb>, ref: string, at: string, observations: MarketObservation[]) {
  saveObservationBatch(db, { ref, source_ref: "hongguo", source_revision: 1, observed_at: at, origin: "fixture", observations });
}

function seed() {
  const db = openDb(":memory:");
  initializeMarket(db);
  // Review window under test: 2026-09-06 .. 2026-09-13. Daily interval
  // observations form one adjacent chain per work, so the last in-window
  // revision is the original and the 09-13 observation is the comparable
  // follow-up right after the window boundary.
  const series: Record<string, number[]> = {
    "sustained-work": [100, 110, 120, 130, 140, 150, 160],   // keeps rising after the window
    "cooled-work": [100, 110, 120, 130, 140, 150, 60],       // drops in the follow-up
    "retracted-work": [100, 110, 120, 130, 140, 150],        // no metric follow-up; corrected after the window
    "inconclusive-work": [100, 110, 120, 130, 140, 150],     // no follow-up at all
  };
  for (let day = 7; day <= 13; day++) {
    const dd = String(day).padStart(2, "0");
    const prev = String(day - 1).padStart(2, "0");
    // Complete interval windows end at the observation day's 00:00 boundary,
    // matching the brief fixtures (observed 08:00, window = previous day).
    const observations = Object.entries(series)
      .filter(([, values]) => values.length > day - 7)
      .map(([work, values], i) => observation("r-" + dd + "-" + i, work,
        "2026-09-" + dd + "T08:00:00Z", "2026-09-" + prev + "T00:00:00Z", "2026-09-" + dd + "T00:00:00Z",
        values[day - 7]!));
    if (observations.length) batch(db, "rv-" + dd, "2026-09-" + dd + "T08:00:00Z", observations);
  }
  analyzeMarket(db, "2026-09-07T00:00:00Z", "2026-09-14T00:00:00Z");
  db.insert(marketEvidence).values({ ref: "evidence-retraction", sourceRef: "hongguo",
    observedAt: "2026-09-13T08:00:00Z",
    payload: { title: "Retracting snapshot", public_url: "", source_item_id: "retracted-work", origin: "fixture" } }).run();
  // Correct the metric signal head inside the window (observed 09-12), so
  // the review pairs the retraction with the same signal ref.
  const retracted = db.select().from(marketSignals).all()
    .map(r => r.payload).find(s => s.title === "Review fixture retracted-work" &&
      s.claim_kind === "metric_changed" && s.observed_at === "2026-09-12T08:00:00.000Z")!;
  correctSignal(db, { ref: retracted.signal_ref, expected_revision: retracted.revision, reason: "source removed the listing",
    evidence_refs: ["evidence-retraction"], outcome: "retracted", corrected_at: "2026-09-14T09:00:00Z" });
  return db;
}

test("review reports all four outcomes with original and follow-up refs", () => {
  const db = seed();
  try {
    const { review } = buildMarketReview(db, "2026-09-06T00:00:00Z", "2026-09-13T00:00:00Z", "2026-09-15T00:00:00Z", new Date("2026-09-15T09:00:00Z"));
    // Each work also carries a newly_observed signal; judge outcomes on the
    // metric entries that actually have follow-up semantics.
    const byTitle = Object.fromEntries(review.entries
      .filter(e => e.original.claim_kind === "metric_changed").map(e => [e.original.title, e]));
    expect(Object.keys(byTitle)).toHaveLength(4);
    expect(review.window).toEqual({ start: "2026-09-06T00:00:00.000Z", end: "2026-09-13T00:00:00.000Z" });
    expect(byTitle["Review fixture sustained-work"].outcome).toBe("sustained");
    expect(byTitle["Review fixture cooled-work"].outcome).toBe("cooled");
    expect(byTitle["Review fixture retracted-work"].outcome).toBe("retracted");
    expect(byTitle["Review fixture inconclusive-work"].outcome).toBe("inconclusive");
    // Original and follow-up revisions are both referenced and immutable.
    expect(byTitle["Review fixture sustained-work"].original.observed_at).toBe("2026-09-12T08:00:00.000Z");
    expect(byTitle["Review fixture sustained-work"].followup!.observed_at).toBe("2026-09-13T08:00:00.000Z");
    expect(byTitle["Review fixture inconclusive-work"].followup).toBeNull();
    expect(review.limitations.join(" ")).toContain("never a failed prediction");
  } finally { db.$client.close(); }
});

test("rebuild is idempotent; later follow-ups mint a new review, cutoffs exclude them", () => {
  const db = seed();
  try {
    const first = buildMarketReview(db, "2026-09-06T00:00:00Z", "2026-09-13T00:00:00Z", "2026-09-15T00:00:00Z", new Date("2026-09-15T09:00:00Z"));
    const replay = buildMarketReview(db, "2026-09-06T00:00:00Z", "2026-09-13T00:00:00Z", "2026-09-15T00:00:00Z", new Date("2026-09-15T09:00:00Z"));
    expect(replay.reused).toBe(true);
    expect(replay.review).toEqual(first.review);
    expect(readMarketReview(db, first.review.review_ref).digest).toBe(first.review.digest);
    // An earlier cutoff cannot see the follow-ups: everything is honestly inconclusive.
    const early = buildMarketReview(db, "2026-09-06T00:00:00Z", "2026-09-13T00:00:00Z", "2026-09-13T06:00:00Z", new Date("2026-09-15T09:00:00Z"));
    expect(early.review.review_ref).not.toBe(first.review.review_ref);
    expect(early.review.entries.every(e => e.outcome === "inconclusive")).toBe(true);
    // Future cutoffs are refused outright.
    expect(() => buildMarketReview(db, "2026-09-06T00:00:00Z", "2026-09-13T00:00:00Z", "2026-09-16T00:00:00Z", new Date("2026-09-15T09:00:00Z"))).toThrow("no future cutoff");
  } finally { db.$client.close(); }
});
