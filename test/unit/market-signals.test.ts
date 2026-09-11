import { expect, test } from "bun:test";
import { openDb } from "../../src/db/client.ts";
import { initializeMarket } from "../../src/market/sources.ts";
import { saveObservationBatch } from "../../src/market/repository.ts";
import { recordSamplingCheck } from "../../src/market/sampling.ts";
import {
  analyzeMarket, compareMarketSignalOrder, MARKET_SIGNAL_ORDER_VERSION, signalByRef,
  type MarketSignal,
} from "../../src/market/signals.ts";
import { marketEvidence } from "../../src/db/schema.ts";
import type { Market, MarketObservation } from "../../src/market/domain.ts";

function observation(input: {
  ref: string; item: string; at: string; topics?: string[]; market?: Market; source?: string;
}): MarketObservation {
  const market = input.market ?? "unknown";
  return {
    spec: "radar.market_observation.v1", observation_ref: input.ref,
    source_ref: input.source ?? "hongguo", source_revision: 1, source_item_id: input.item,
    source_snapshot_ref: "snapshot-" + input.ref, observed_at: input.at, source_published_at: null,
    market, market_evidence_refs: /^[A-Z]{2}$/.test(market) ? ["region-evidence-" + market] : [],
    locale: "zh", format: "unknown", production_method: "unknown", production_evidence_refs: [],
    title: "Fixture work " + input.item, topics: input.topics ?? [], facts: [],
    evidence_refs: ["evidence-" + input.ref], collection_run_ref: "run-" + input.at, origin: "fixture",
  };
}

const saveBatch = (db: ReturnType<typeof openDb>, ref: string, at: string, items: MarketObservation[], source = "hongguo") =>
  saveObservationBatch(db, { ref, source_ref: source, source_revision: 1, observed_at: at, origin: "fixture", observations: items });

const signalsOf = (db: ReturnType<typeof openDb>, refs: Array<{ ref: string; revision: number }>) =>
  refs.map(s => signalByRef(db, s.ref, s.revision)!);

test("directory changes become listing signals with additions confirmed and removals gated on completeness", () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    saveBatch(db, "listing-b1", "2026-09-10T08:00:00Z", [
      observation({ ref: "lo-1", item: "w1", at: "2026-09-10T08:00:00Z" }),
      observation({ ref: "lo-2", item: "w2", at: "2026-09-10T08:00:00Z" }),
    ]);
    saveBatch(db, "listing-b2", "2026-09-11T08:00:00Z", [
      observation({ ref: "lo-3", item: "w2", at: "2026-09-11T08:00:00Z" }),
      observation({ ref: "lo-4", item: "w3", at: "2026-09-11T08:00:00Z" }),
    ]);
    const first = analyzeMarket(db, "2026-09-11T00:00:00Z", "2026-09-12T00:00:00Z");
    const listing = signalsOf(db, first.signals).find(s => s.claim_kind === "listing_changed")!;
    expect(listing).toBeDefined();
    // No completeness attestation exists for the later batch, so the removal
    // cannot be confirmed even though the addition is directly evidenced.
    expect(listing.assertion_level).toBe("observed");
    expect(listing.listing).toMatchObject({
      added: [{ source_item_id: "w3" }], removed: [{ source_item_id: "w1" }],
      snapshot_before: "2026-09-10T08:00:00.000Z", snapshot_after: "2026-09-11T08:00:00.000Z",
      removal_verified: false,
    });
    expect(listing.limitations.some(l => /delist/i.test(l))).toBe(true);
    expect(listing.observation_refs.length).toBeGreaterThan(0);
    expect(listing.independent_evidence_groups).toBe(1);
    // An owner sampling check attesting completeness upgrades the claim
    // through a new revision; the unconfirmed revision stays readable.
    db.insert(marketEvidence).values({
      ref: "listing-sample-evidence", sourceRef: "hongguo", observedAt: "2026-09-11T08:00:00.000Z",
      payload: { title: "Fixture sample", public_url: "https://example.com/sample", source_item_id: "w3", origin: "fixture" },
    }).run();
    recordSamplingCheck(db, {
      batch_ref: "listing-b2", scheduled_at: "2026-09-11T07:00:00Z", checked_at: "2026-09-11T09:00:00Z",
      completeness: "complete", stable_ids: true, metric_contract_valid: true, failure_sample_ref: "listing-sample-evidence",
    }, new Date("2026-09-11T10:00:00Z"));
    const second = analyzeMarket(db, "2026-09-11T00:00:00Z", "2026-09-12T00:00:00Z");
    expect(second.created).toBe(1);
    expect(signalByRef(db, listing.signal_ref)).toMatchObject({ revision: 2, assertion_level: "confirmed" });
    expect(signalByRef(db, listing.signal_ref)!.listing!.removal_verified).toBe(true);
    expect(signalByRef(db, listing.signal_ref, 1)).toEqual(listing);
    expect(analyzeMarket(db, "2026-09-11T00:00:00Z", "2026-09-12T00:00:00Z").created).toBe(0);
  } finally { db.$client.close(); }
});

test("topic mix requires ten works per window and an attested complete frame before confirmation", () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    const topicWorks = (day: number, revengeCount: number) => {
      const items: MarketObservation[] = [];
      for (let i = 1; i <= 12; i++) {
        items.push(observation({
          ref: `tm-${day}-${i}`, item: "w" + i, at: `2026-09-${day}T08:00:00Z`,
          topics: [i <= revengeCount ? "revenge" : "suspense"],
        }));
      }
      return items;
    };
    saveBatch(db, "topic-b1", "2026-09-10T08:00:00Z", topicWorks(10, 6));
    saveBatch(db, "topic-b2", "2026-09-11T08:00:00Z", topicWorks(11, 9));
    // A second directory with only eight works per window must never confirm.
    const smallWorks = (day: number) => Array.from({ length: 8 }, (_, i) =>
      observation({ ref: `ts-${day}-${i}`, item: "s" + i, at: `2026-09-${day}T08:00:00Z`,
        topics: [i < (day === 10 ? 4 : 6) ? "revenge" : "suspense"], source: "reelshort" }));
    saveBatch(db, "topic-s1", "2026-09-10T08:00:00Z", smallWorks(10), "reelshort");
    saveBatch(db, "topic-s2", "2026-09-11T08:00:00Z", smallWorks(11), "reelshort");
    const result = analyzeMarket(db, "2026-09-11T00:00:00Z", "2026-09-12T00:00:00Z");
    const mix = signalsOf(db, result.signals).filter(s => s.claim_kind === "topic_mix_changed");
    const revenge = mix.find(s => s.topic_mix?.topic === "revenge" && s.source_ref === "hongguo")!;
    expect(revenge).toBeDefined();
    // The frame is not attested complete yet, so shares stay observed.
    expect(revenge.assertion_level).toBe("observed");
    expect(revenge.topic_mix).toMatchObject({
      before: { works: 12, topic_works: 6, share: 0.5 }, after: { works: 12, topic_works: 9, share: 0.75 },
    });
    expect(revenge.limitations.some(l => /completeness/i.test(l))).toBe(true);
    const small = mix.find(s => s.topic_mix?.topic === "revenge" && s.source_ref === "reelshort")!;
    expect(small.assertion_level).toBe("observed");
    expect(small.topic_mix?.before.works).toBe(8);
    expect(small.limitations.some(l => /10/.test(l))).toBe(true);
    expect(mix.find(s => s.source_ref === "hongguo" && s.topic_mix?.topic === "suspense")!.topic_mix)
      .toMatchObject({ before: { topic_works: 6, share: 0.5 }, after: { topic_works: 3, share: 0.25 } });
    db.insert(marketEvidence).values({
      ref: "topic-sample-evidence", sourceRef: "hongguo", observedAt: "2026-09-11T08:00:00.000Z",
      payload: { title: "Fixture sample", public_url: "https://example.com/sample", source_item_id: "w1", origin: "fixture" },
    }).run();
    recordSamplingCheck(db, {
      batch_ref: "topic-b2", scheduled_at: "2026-09-11T07:00:00Z", checked_at: "2026-09-11T09:00:00Z",
      completeness: "complete", stable_ids: true, metric_contract_valid: true, failure_sample_ref: "topic-sample-evidence",
    }, new Date("2026-09-11T10:00:00Z"));
    analyzeMarket(db, "2026-09-11T00:00:00Z", "2026-09-12T00:00:00Z");
    expect(signalByRef(db, revenge.signal_ref)).toMatchObject({ revision: 2, assertion_level: "confirmed" });
    // The small directory still never confirms.
    expect(signalByRef(db, small.signal_ref)!.assertion_level).toBe("observed");
  } finally { db.$client.close(); }
});

test("cross-market observation requires evidenced regions and independent publishers for corroboration", () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    saveBatch(db, "cm-cn", "2026-09-10T08:00:00Z", [
      observation({ ref: "cm-1", item: "cn-1", at: "2026-09-10T08:00:00Z", topics: ["revenge"], market: "CN" }),
    ]);
    // Same publisher group (hongguo owns both hongguo and hongguo-animation)
    // in another region: syndication must not count as independent support.
    saveBatch(db, "cm-us", "2026-09-10T08:00:00Z", [
      observation({ ref: "cm-2", item: "us-1", at: "2026-09-10T08:00:00Z", topics: ["revenge"], market: "US", source: "hongguo-animation" }),
    ], "hongguo-animation");
    const first = analyzeMarket(db, "2026-09-10T00:00:00Z", "2026-09-11T00:00:00Z");
    const syndicated = signalsOf(db, first.signals).find(s => s.claim_kind === "cross_market_observed")!;
    expect(syndicated).toBeDefined();
    expect(syndicated.assertion_level).toBe("observed");
    expect(syndicated.independent_evidence_groups).toBe(1);
    expect(syndicated.cross_market!.markets.map(m => m.market)).toEqual(["CN", "US"]);
    expect(syndicated.limitations.some(l => /caus/i.test(l))).toBe(true);
    expect(syndicated.market).toBe("unknown");
    // A genuinely independent publisher in a third region upgrades the same
    // topic claim to corroborated through a new revision.
    saveBatch(db, "cm-mx", "2026-09-11T08:00:00Z", [
      observation({ ref: "cm-3", item: "mx-1", at: "2026-09-11T08:00:00Z", topics: ["revenge"], market: "MX", source: "reelshort" }),
    ], "reelshort");
    const second = analyzeMarket(db, "2026-09-11T00:00:00Z", "2026-09-12T00:00:00Z");
    const corroborated = signalsOf(db, second.signals).find(s => s.claim_kind === "cross_market_observed")!;
    expect(corroborated.signal_ref).toBe(syndicated.signal_ref);
    expect(corroborated.assertion_level).toBe("corroborated");
    expect(corroborated.independent_evidence_groups).toBe(2);
    expect(corroborated.cross_market!.markets.map(m => m.market)).toEqual(["CN", "MX", "US"]);
    expect(signalByRef(db, syndicated.signal_ref, 1)).toEqual(syndicated);
    // Regions without country evidence never enter cross-market claims.
    saveBatch(db, "cm-unknown", "2026-09-11T08:00:00Z", [
      observation({ ref: "cm-4", item: "u-1", at: "2026-09-11T08:00:00Z", topics: ["suspense"] }),
    ]);
    const third = analyzeMarket(db, "2026-09-11T00:00:00Z", "2026-09-12T00:00:00Z");
    expect(signalsOf(db, third.signals).some(s => s.claim_kind === "cross_market_observed" && s.topics.includes("suspense"))).toBe(false);
  } finally { db.$client.close(); }
});

test("signal ordering is versioned, deterministic and explainable", () => {
  expect(MARKET_SIGNAL_ORDER_VERSION).toBe("market-signal-order.v1");
  const base: MarketSignal = {
    spec: "radar.market_signal.v1", signal_ref: "signal-x", revision: 1,
    claim_kind: "newly_observed", assertion_level: "observed", lifecycle: "active",
    subject_ref: "work-x", source_ref: "hongguo", market: "unknown", title: "x", topics: [],
    observed_at: "2026-09-10T08:00:00Z", observation_refs: [], evidence_refs: [], comparison: null,
    limitations: [], analysis_version: "v", mapping_version: "v", origin: "fixture",
  };
  const role = { hongguo: "catalog", douyin: "discussion" } as const;
  const roleOf = (ref: string) => (role as Record<string, "catalog" | "discussion">)[ref];
  const correction = { ...base, claim_kind: "correction" as const };
  const confirmed = { ...base, signal_ref: "signal-confirmed", claim_kind: "metric_changed" as const, assertion_level: "confirmed" as const };
  const corroborated = { ...base, signal_ref: "signal-corroborated", claim_kind: "cross_market_observed" as const, assertion_level: "corroborated" as const };
  const observed = { ...base, signal_ref: "signal-observed" };
  const order = [correction, confirmed, corroborated, observed];
  for (let i = 0; i < order.length; i++) for (let j = 0; j < order.length; j++) {
    expect(Math.sign(compareMarketSignalOrder(order[i], order[j], roleOf))).toBe(Math.sign(i - j));
  }
  // Source priority: catalog outranks discussion at the same assertion level.
  const discussion = { ...observed, source_ref: "douyin" };
  expect(compareMarketSignalOrder(observed, discussion, roleOf)).toBeLessThan(0);
  // More independent evidence groups rank first; then newer observations.
  const twoGroups = { ...observed, signal_ref: "signal-groups", independent_evidence_groups: 2 };
  expect(compareMarketSignalOrder(twoGroups, observed, roleOf)).toBeLessThan(0);
  const newer = { ...observed, observed_at: "2026-09-11T08:00:00Z" };
  expect(compareMarketSignalOrder(newer, observed, roleOf)).toBeLessThan(0);
  // The signal ref is the final stable tiebreak for identical facts.
  const other = { ...observed, signal_ref: "signal-z" };
  expect(compareMarketSignalOrder(observed, other, roleOf)).toBeLessThan(0);
  expect(compareMarketSignalOrder(observed, { ...observed }, roleOf)).toBe(0);
});
