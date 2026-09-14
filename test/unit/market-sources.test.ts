import { expect, test } from "bun:test";
import { openDb } from "../../src/db/client.ts";
import { initializeMarket, registerSourceCandidate } from "../../src/market/sources.ts";
import { qualificationRecord, qualificationReport, recordQualification, sourceGaps } from "../../src/market/qualification.ts";
import { reviewSource } from "../../src/market/source-review.ts";
import { saveObservationBatch } from "../../src/market/repository.ts";
import type { MarketObservation } from "../../src/market/domain.ts";

// Tasks 1.8 and 1.22: unified source qualification and gap reporting, plus
// the regional candidate discovery entry. Readiness (can this source be
// trusted for its declared scope) and health (is it being read right now)
// stay separate fields; an app listing or identity note never substitutes
// for work-level observation data.

const NOW = new Date("2026-09-12T00:00:00Z");

function observation(item: string, observedAt: string, origin: MarketObservation["origin"]): MarketObservation {
  return {
    spec: "radar.market_observation.v1", observation_ref: "obs-" + item + "-" + origin + "-" + observedAt,
    source_ref: "hongguo", source_revision: 1, source_item_id: item,
    source_snapshot_ref: "snap-" + item + "-" + origin + "-" + observedAt, observed_at: observedAt,
    source_published_at: null, market: "unknown", market_evidence_refs: [], locale: "zh-CN",
    format: "unknown", production_method: "unknown", production_evidence_refs: [],
    title: "作品 " + item, topics: [], facts: [], evidence_refs: ["ev-" + item + "-" + observedAt],
    collection_run_ref: "run-unit", origin,
  };
}

test("qualification separates readiness from health and names every blocker", () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    // A store listing alone is not work data: fixture and manual batches
    // count toward neither live qualification nor freshness.
    saveObservationBatch(db, { ref: "b-fixture", source_ref: "hongguo", source_revision: 1,
      observed_at: "2026-09-11T08:00:00Z", origin: "fixture",
      observations: [observation("w1", "2026-09-11T08:00:00Z", "fixture")] });
    saveObservationBatch(db, { ref: "b-manual", source_ref: "hongguo", source_revision: 1,
      observed_at: "2026-09-11T20:00:00Z", origin: "manual",
      observations: [observation("w1", "2026-09-11T20:00:00Z", "manual")] });
    const report = qualificationReport(db, "hongguo", NOW);
    expect(report.qualified).toBe(false);
    // Health reflects live reads only: no live batch means unavailable even
    // though manual/fixture samples exist.
    expect(report.health).toBe("unavailable");
    expect(report.sample_batches).toEqual({ live: 0, manual: 1, fixture: 1 });
    expect(report.reasons).toContain("identity_evidence_missing");
    // A manual sample with provenance counts as a non-fixture sample, but a
    // store listing or app identity still cannot substitute for seven live
    // days of work-level observation.
    expect(report.reasons).not.toContain("non_fixture_sample_missing");
    expect(report.reasons).toContain("seven_complete_live_days_missing");
    expect(report.reasons).toContain("sampling_plan_not_preregistered");
    expect(report.reasons).toContain("sample_review_required");
    // Qualification is frozen as an immutable record with replay reuse.
    const first = recordQualification(db, "hongguo", 1, NOW);
    expect(first.reused).toBe(false);
    expect((recordQualification(db, "hongguo", 1, NOW)).reused).toBe(true);
    const stored = qualificationRecord(db, first.record.record_ref);
    expect(stored.rule_version).toBe("market-qualification.v1");
    expect(stored.report.qualified).toBe(false);
    // Stale revision refuses to record a new result.
    expect(() => recordQualification(db, "hongguo", 2, NOW)).toThrow("revision");
  } finally { db.$client.close(); }
});

test("a blocked source surfaces its reason without disappearing from the ledger", () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    reviewSource(db, { key: "block-hongguo", source_ref: "hongguo", revision: 1, stage: "blocked",
      reason: "Listing requires an account; no public work-level page", evidence_refs: [] });
    const report = qualificationReport(db, "hongguo", NOW);
    expect(report.configured_readiness).toBe("blocked");
    expect(report.reasons).toContain("source_blocked");
    expect(report.limitations.some(line => line.includes("account"))).toBe(true);
    // Industry sources stay background, never daily trend input.
    const industry = qualificationReport(db, "dataeye", NOW);
    expect(industry.reasons).toContain("background_source_not_daily_trend");
  } finally { db.$client.close(); }
});

test("agents can register regional candidates; the gap matrix stays honest", () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    const registered = registerSourceCandidate(db, { source_ref: "th-short-portal", publisher_group: "th-portal",
      locale: "th", markets: ["TH"], note: "Public weekly listing found during research" });
    expect(registered.reused).toBe(false);
    expect(registered.source.readiness).toBe("planned");
    expect(registered.source.market_scope).toEqual(["TH"]);
    expect(registered.source.limitations.some(line => line.includes("does not install"))).toBe(true);
    // Registration is declarative and idempotent; conflicting parameters
    // for the same ref are refused instead of overwritten.
    expect(registerSourceCandidate(db, { source_ref: "th-short-portal", publisher_group: "th-portal", locale: "th", markets: ["TH"] }).reused).toBe(true);
    expect(() => registerSourceCandidate(db, { source_ref: "th-short-portal", publisher_group: "other", locale: "th", markets: ["TH"] })).toThrow("different parameters");
    expect(() => registerSourceCandidate(db, { source_ref: "bad", publisher_group: "g", locale: "th", markets: ["usa"] })).toThrow("declared markets");
    expect(() => registerSourceCandidate(db, { source_ref: "bad", publisher_group: "g", locale: "th", markets: [] })).toThrow("declared markets");
    // The fixed region matrix keeps breadth without claiming coverage.
    const gaps = sourceGaps(db, NOW);
    expect(gaps.candidate_entry).toBe("radar market source register-candidate");
    const markets = gaps.markets.map(market => market.market);
    expect(markets).toEqual(["CN", "US", "MX", "BR", "ID", "IN", "TH", "PH", "JP", "KR", "GB", "DE", "FR"]);
    const th = gaps.markets.find(market => market.market === "TH")!;
    expect(th.declared_sources).toContain("th-short-portal");
    expect(th.verified_sources).toEqual([]);
    expect(th.status).toBe("coverage_unverified");
    for (const market of gaps.markets) {
      expect(market.status).toBe("coverage_unverified");
      expect(market.reason).toContain("do not prove audience");
    }
    // Every candidate still receives a full qualification report.
    expect(gaps.sources.find(source => source.source_ref === "th-short-portal")!.reasons.length).toBeGreaterThan(0);
  } finally { db.$client.close(); }
});
