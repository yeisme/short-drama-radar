import { expect, test } from "bun:test";
import { openDb } from "../../src/db/client.ts";
import { initializeMarket, updateSettings } from "../../src/market/sources.ts";
import { saveObservationBatch } from "../../src/market/repository.ts";
import { analyzeMarket, signalByRef } from "../../src/market/signals.ts";
import { buildMarketBrief, readMarketBrief } from "../../src/market/brief.ts";
import { buildMarketReview, readMarketReview } from "../../src/market/review.ts";
import { catchUp } from "../../src/market/catchup.ts";
import { changeReadState, readReader } from "../../src/market/reader.ts";
import { crossMarketView } from "../../src/market/cross-market.ts";
import { evidenceForSignal, questionContext } from "../../src/market/question.ts";
import { assertMarketContentReadable, marketReadPolicy } from "../../src/market/policy.ts";
import { ProfileService } from "../../src/profile/service.ts";
import { marketReviews, marketSignals } from "../../src/db/schema.ts";
import type { MarketObservation } from "../../src/market/domain.ts";
import type { MarketSignal } from "../../src/market/signals.ts";

// S14: the blocked-topic union (market settings + active Profile) is the only
// market filter, it is enforced on every read exit, and personal_fit or
// ordinary creation preferences never hide market changes.

// Interval facts make two comparable observations per work: the earlier is
// the baseline, the later lands inside the analysis window (same shape as
// the brief unit fixtures).
function observation(input: { ref: string; item: string; observedAt: string; start: string; end: string; value: number; topics: string[]; title?: string }): MarketObservation {
  return {
    spec: "radar.market_observation.v1", observation_ref: input.ref,
    source_ref: "hongguo", source_revision: 1, source_item_id: input.item,
    source_snapshot_ref: "snapshot-" + input.ref, observed_at: input.observedAt, source_published_at: null,
    market: "unknown", market_evidence_refs: [], locale: "zh", format: "unknown",
    production_method: "unknown", production_evidence_refs: [], title: input.title ?? "Policy fixture " + input.item,
    topics: input.topics, facts: [{ name: "engagement", value: input.value, unit: "count", basis: "interval",
      window: { start: input.start, end: input.end }, definition_version: "v1", sample_denominator: null }],
    evidence_refs: ["evidence-" + input.ref], collection_run_ref: "run-policy", origin: "fixture",
  };
}

function intervalPair(item: string, topics: string[], title?: string) {
  const common = { item, topics, ...(title ? { title } : {}) };
  return [
    observation({ ...common, ref: "pp-" + item, observedAt: "2026-09-11T08:00:00Z", start: "2026-09-10T00:00:00Z", end: "2026-09-11T00:00:00Z", value: 100 }),
    observation({ ...common, ref: "cp-" + item, observedAt: "2026-09-12T08:00:00Z", start: "2026-09-11T00:00:00Z", end: "2026-09-12T00:00:00Z", value: 130 }),
  ];
}

function seedSignals(db: ReturnType<typeof openDb>) {
  const works = [
    ...intervalPair("blocked-work", ["revenge"], "Revenge Secret Fixture"),
    ...intervalPair("open-work", ["suspense"]),
    ...intervalPair("unclassified-work", []),
  ];
  saveObservationBatch(db, { ref: "policy-prior", source_ref: "hongguo", source_revision: 1,
    observed_at: "2026-09-11T08:00:00Z", origin: "fixture", observations: works.filter(o => o.observed_at === "2026-09-11T08:00:00Z") });
  saveObservationBatch(db, { ref: "policy-current", source_ref: "hongguo", source_revision: 1,
    observed_at: "2026-09-12T08:00:00Z", origin: "fixture", observations: works.filter(o => o.observed_at === "2026-09-12T08:00:00Z") });
  analyzeMarket(db, "2026-09-12T00:00:00Z", "2026-09-13T00:00:00Z");
  const byTopic = (topics: string[]) => db.select().from(marketSignals).all()
    .map(row => row.payload).filter(s => s.topics.length === topics.length && topics.every(t => s.topics.includes(t)))[0] as MarketSignal;
  return { blocked: byTopic(["revenge"]), open: byTopic(["suspense"]), unclassified: byTopic([]) };
}

function dbWithSignals() {
  const db = openDb(":memory:");
  initializeMarket(db);
  const signals = seedSignals(db);
  buildMarketBrief(db, "2026-09-12T00:00:00Z", "2026-09-13T00:00:00Z", new Date("2026-09-13T08:00:00Z"));
  buildMarketReview(db, "2026-09-12T00:00:00Z", "2026-09-13T00:00:00Z", "2026-09-14T08:00:00Z", new Date("2026-09-14T09:00:00Z"));
  return { db, signals };
}

test("blocked topics are enforced on every read exit without leaking content", () => {
  const { db, signals } = dbWithSignals();
  try {
    updateSettings(db, 1, { blocked_topics: ["revenge"] });
    // Brief projection hides the blocked signal and flags the filter.
    const brief = readMarketBrief(db);
    expect(brief.filtered).toBe(true);
    expect(brief.visible_signal_refs.some(r => r.ref === signals.blocked.signal_ref)).toBe(false);
    expect(brief.visible_signal_refs.some(r => r.ref === signals.open.signal_ref)).toBe(true);
    // Deep link by exact signal ref/revision cannot bypass the policy.
    expect(() => assertMarketContentReadable(db, signals.blocked.topics)).toThrow("not been classified");
    expect(signalByRef(db, signals.blocked.signal_ref, 1)).toBeDefined(); // the row exists; the exit refuses
    // Evidence deep link refuses and never echoes the blocked title.
    try {
      evidenceForSignal(db, signals.blocked.signal_ref, 1, signals.blocked.evidence_refs[0]!);
      throw new Error("expected content_blocked");
    } catch (error) {
      expect((error as Error).message).toContain("not been classified");
      expect((error as Error).message).not.toContain("Revenge Secret Fixture");
    }
    // Question context refuses for the blocked signal.
    expect(() => questionContext(db, { signal_ref: signals.blocked.signal_ref, revision: 1, question: "Why?" })).toThrow("not been classified");
    // Catch-up filters blocked and unclassified signals; unblocked survive.
    const catchup = catchUp(db, { now: new Date("2026-09-14T08:00:00Z") });
    expect(catchup.signals.some(s => s.signal_ref === signals.blocked.signal_ref)).toBe(false);
    expect(catchup.signals.some(s => s.signal_ref === signals.unclassified.signal_ref)).toBe(false);
    expect(catchup.signals.some(s => s.signal_ref === signals.open.signal_ref)).toBe(true);
    // A single blocked side refuses the whole cross-market comparison.
    expect(() => crossMarketView(db,
      { signal_ref: signals.open.signal_ref, revision: 1 },
      { signal_ref: signals.blocked.signal_ref, revision: 1 })).toThrow("not been classified");
    // Weekly review hides entries whose original signal is blocked.
    const reviewRef = db.select().from(marketReviews).all()[0]!.ref;
    const review = readMarketReview(db, reviewRef);
    expect(review.entries.every(e => e.original.signal_ref !== signals.blocked.signal_ref)).toBe(true);
    expect(review.filtered).toBe(true);
  } finally { db.$client.close(); }
});

test("profile switch changes the policy revision and invalidates stale reader writes", () => {
  const { db, signals } = dbWithSignals();
  try {
    const profiles = new ProfileService(db);
    profiles.create("A"); // first profile becomes active
    const before = marketReadPolicy(db);
    const b = profiles.create("B", { blocked_topics: ["suspense"] });
    profiles.activate(b.ref);
    const after = marketReadPolicy(db);
    expect(after.blocked_topics).toEqual(["suspense"]);
    expect(after.policy_revision).not.toBe(before.policy_revision);
    // Union with market settings stays deduplicated and sorted.
    updateSettings(db, 1, { blocked_topics: ["revenge"] });
    expect(marketReadPolicy(db).blocked_topics).toEqual(["revenge", "suspense"]);
    // Switching back removes only the profile's topics.
    profiles.activate("profile-a");
    expect(marketReadPolicy(db).blocked_topics).toEqual(["revenge"]);
    // A reader write signed with the pre-switch policy revision conflicts.
    const reader = readReader(db);
    expect(() => changeReadState(db, { action: "mark", idempotency_key: "stale-policy-1",
      expected_revision: reader.revision, policy_revision: before.policy_revision,
      signals: [{ ref: signals.open.signal_ref, revision: 1 }] })).toThrow("changed");
    expect(changeReadState(db, { action: "mark", idempotency_key: "fresh-policy-1",
      expected_revision: reader.revision, policy_revision: marketReadPolicy(db).policy_revision,
      signals: [{ ref: signals.open.signal_ref, revision: 1 }] }).outcome).toBe("success");
  } finally { db.$client.close(); }
});

test("personal preferences and personal_fit never filter market reads", () => {
  const { db, signals } = dbWithSignals();
  try {
    const profiles = new ProfileService(db);
    // Strong personalization: minimum fit/confidence 100, zero risk budget,
    // weighted topic preferences that disagree with the observed works.
    profiles.create("picky", {
      risk_tolerance: 0, minimum_fit: 100, minimum_confidence: 100,
      topics: [{ tag: "sweet_romance", weight: 100 }], genres: [{ tag: "urban", weight: 100 }],
    });
    expect(marketReadPolicy(db).blocked_topics).toEqual([]);
    const brief = readMarketBrief(db);
    expect(brief.filtered).toBe(false);
    expect(brief.visible_signal_refs.some(r => r.ref === signals.open.signal_ref)).toBe(true);
    expect(brief.visible_signal_refs.some(r => r.ref === signals.blocked.signal_ref)).toBe(true);
    const catchup = catchUp(db, { now: new Date("2026-09-14T08:00:00Z") });
    expect(catchup.signals.some(s => s.signal_ref === signals.blocked.signal_ref)).toBe(true);
  } finally { db.$client.close(); }
});

test("reads work without any profile", () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    const policy = marketReadPolicy(db);
    expect(policy.blocked_topics).toEqual([]);
    expect(catchUp(db, { now: new Date("2026-09-14T08:00:00Z") }).signals).toEqual([]);
  } finally { db.$client.close(); }
});
