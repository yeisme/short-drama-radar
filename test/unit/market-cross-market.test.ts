import { expect, test } from "bun:test";
import { openDb } from "../../src/db/client.ts";
import { initializeMarket } from "../../src/market/sources.ts";
import { saveObservationBatch } from "../../src/market/repository.ts";
import { analyzeMarket } from "../../src/market/signals.ts";
import { crossMarketView } from "../../src/market/cross-market.ts";
import { refreshWorkCandidate, reviewWorkMapping, workMapping } from "../../src/market/identity.ts";
import { marketEvidence, marketSignals } from "../../src/db/schema.ts";
import type { Market, MarketObservation } from "../../src/market/domain.ts";

// S15: cross-market comparison keeps both sides' original names, market
// evidence, windows and metric definitions side by side — never a shared
// numeric axis or a causal claim. Candidate mappings never upgrade to
// "same work"; only explicit reviews on both sides do.

function observation(input: { ref: string; source: string; item: string; observedAt: string; start: string; end: string; value: number; market: Market; marketEvidenceRefs: string[] }): MarketObservation {
  return {
    spec: "radar.market_observation.v1", observation_ref: input.ref,
    source_ref: input.source, source_revision: 1, source_item_id: input.item,
    source_snapshot_ref: "snapshot-" + input.ref, observed_at: input.observedAt, source_published_at: null,
    market: input.market, market_evidence_refs: input.marketEvidenceRefs, locale: "en", format: "unknown",
    production_method: "unknown", production_evidence_refs: [], title: "Shared Work Title",
    topics: ["suspense"], facts: [{ name: "engagement", value: input.value, unit: "count", basis: "interval",
      window: { start: input.start, end: input.end }, definition_version: "v1", sample_denominator: null }],
    evidence_refs: ["evidence-" + input.ref], collection_run_ref: "run-compare", origin: "fixture",
  };
}

function seed() {
  const db = openDb(":memory:");
  initializeMarket(db);
  const sides = [
    { source: "hongguo", item: "cn-1", market: "CN" as const, evidence: ["evidence-market-cn"], value: 130 },
    { source: "reelshort", item: "global-1", market: "unknown" as const, evidence: [] as string[], value: 90 },
  ];
  for (const [index, side] of sides.entries()) {
    saveObservationBatch(db, { ref: "cmp-prior-" + index, source_ref: side.source, source_revision: 1,
      observed_at: "2026-09-11T08:00:00Z", origin: "fixture", observations: [
        observation({ ref: "p-" + index, source: side.source, item: side.item, observedAt: "2026-09-11T08:00:00Z",
          start: "2026-09-10T00:00:00Z", end: "2026-09-11T00:00:00Z", value: side.value - 30, market: side.market, marketEvidenceRefs: side.evidence })] });
    saveObservationBatch(db, { ref: "cmp-current-" + index, source_ref: side.source, source_revision: 1,
      observed_at: "2026-09-12T08:00:00Z", origin: "fixture", observations: [
        observation({ ref: "c-" + index, source: side.source, item: side.item, observedAt: "2026-09-12T08:00:00Z",
          start: "2026-09-11T00:00:00Z", end: "2026-09-12T00:00:00Z", value: side.value, market: side.market, marketEvidenceRefs: side.evidence })] });
  }
  analyzeMarket(db, "2026-09-12T00:00:00Z", "2026-09-13T00:00:00Z");
  const signals = db.select().from(marketSignals).all().map(r => r.payload);
  const bySource = (source: string) => signals.filter(s => s.source_ref === source).sort((a, b) => b.revision - a.revision)[0]!;
  // Evidence rows for the identity reviews (must reference stored evidence).
  db.insert(marketEvidence).values([
    { ref: "evidence-market-cn", sourceRef: "hongguo", observedAt: "2026-09-11T08:00:00Z",
      payload: { title: "CN market attribution", public_url: "", source_item_id: "cn-1", origin: "fixture" } },
    { ref: "evidence-review-cn", sourceRef: "hongguo", observedAt: "2026-09-11T08:00:00Z",
      payload: { title: "CN identity review note", public_url: "", source_item_id: "cn-1", origin: "fixture" } },
    { ref: "evidence-review-global", sourceRef: "reelshort", observedAt: "2026-09-11T08:00:00Z",
      payload: { title: "Global identity review note", public_url: "", source_item_id: "global-1", origin: "fixture" } },
  ]).run();
  return { db, cn: bySource("hongguo"), globalSide: bySource("reelshort"),
    subjects: { cn: bySource("hongguo").subject_ref, global: bySource("reelshort").subject_ref } };
}

test("candidate mappings stay side-by-side with unknown markets kept explicit", () => {
  const { db, cn, globalSide } = seed();
  try {
    const view = crossMarketView(db, { signal_ref: cn.signal_ref, revision: 1 }, { signal_ref: globalSide.signal_ref, revision: 1 });
    expect(view.spec).toBe("radar.market_cross_market.v1");
    expect(view.identity_relation).toBe("not_established");
    expect(view.presentation).toBe("side_by_side");
    expect(view.shared_numeric_axis).toBe(false);
    expect(view.causal_inference).toBe(false);
    const [left, right] = view.sides;
    expect(left.title).toBe("Shared Work Title");
    expect(right.title).toBe("Shared Work Title");
    expect(left.observations.every(o => o.original_title === "Shared Work Title")).toBe(true);
    // Market evidence stays per side; an English page never becomes US.
    expect(left.observations.every(o => o.market === "CN" && o.market_evidence_refs.includes("evidence-market-cn"))).toBe(true);
    expect(right.observations.every(o => o.market === "unknown")).toBe(true);
    expect(JSON.stringify(view)).not.toMatch(/"US"/);
    // Metric facts keep their own source, unit, window and definition.
    expect(left.observations[0]!.facts[0]!.unit).toBe("count");
    expect(right.observations[0]!.facts[0]!.window).toBeDefined();
    // No combined popularity value exists anywhere in the payload.
    expect(Object.keys(view).some(k => /score|combined|rank_all/i.test(k))).toBe(false);
    // Reading the comparison leaves the reader untouched.
    expect(view.sides.map(s => s.signal_revision)).toEqual([1, 1]);
  } finally { db.$client.close(); }
});

test("explicit reviews on both sides upgrade the relation; candidates alone never do", () => {
  const { db, cn, globalSide, subjects } = seed();
  try {
    refreshWorkCandidate(db, subjects.cn, "Shared Work Title", "evidence-market-cn");
    refreshWorkCandidate(db, subjects.global, "Shared Work Title", "evidence-c-1");
    expect(workMapping(db, subjects.cn)!.mapping_status).toBe("candidate");
    // One-sided verification is not enough.
    reviewWorkMapping(db, { work: subjects.cn, expected_revision: 1, canonical_work_ref: "canonical-shared", evidence_refs: ["evidence-review-cn"] });
    let view = crossMarketView(db, { signal_ref: cn.signal_ref, revision: 1 }, { signal_ref: globalSide.signal_ref, revision: 1 });
    expect(view.identity_relation).toBe("not_established");
    // Both sides reviewed to the same canonical ref: verified same work.
    reviewWorkMapping(db, { work: subjects.global, expected_revision: 1, canonical_work_ref: "canonical-shared", evidence_refs: ["evidence-review-global"] });
    view = crossMarketView(db, { signal_ref: cn.signal_ref, revision: 1 }, { signal_ref: globalSide.signal_ref, revision: 1 });
    expect(view.identity_relation).toBe("verified_same_work");
    expect(view.sides.every(s => s.identity.canonical_work_ref === "canonical-shared")).toBe(true);
  } finally { db.$client.close(); }
});

test("invalid selections are refused without a fallback to the latest revision", () => {
  const { db, cn, globalSide } = seed();
  try {
    expect(() => crossMarketView(db, { signal_ref: "", revision: 1 }, { signal_ref: globalSide.signal_ref, revision: 1 })).toThrow("two stored signal references");
    expect(() => crossMarketView(db, { signal_ref: cn.signal_ref, revision: 99 }, { signal_ref: globalSide.signal_ref, revision: 1 })).toThrow("does not exist");
    expect(() => crossMarketView(db, { signal_ref: cn.signal_ref, revision: 0 }, { signal_ref: globalSide.signal_ref, revision: 1 })).toThrow("positive revisions");
  } finally { db.$client.close(); }
});
