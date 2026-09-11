import { describe, expect, test } from "bun:test";
import { parseMarketObservation, parseMarketSource, parseWorkMapping, isMarketInstant, type MarketObservation } from "../../src/market/domain.ts";

function observation(): MarketObservation {
  return {
    spec: "radar.market_observation.v1", observation_ref: "obs-1",
    source_ref: "hongguo-animation", source_revision: 1, source_item_id: "series-1",
    source_snapshot_ref: "snapshot-1", observed_at: "2026-09-11T08:00:00Z",
    source_published_at: null, market: "unknown", market_evidence_refs: [],
    locale: "zh-CN", format: "animation", production_method: "unknown",
    production_evidence_refs: [], title: "未知制作方式的漫剧", topics: [],
    facts: [], evidence_refs: ["evidence-1"], collection_run_ref: "run-1", origin: "fixture",
  };
}

describe("market observation boundary", () => {
  test("does not infer country or AI production from language or platform", () => {
    const input = observation();
    const result = parseMarketObservation(input);
    expect(result.market).toBe("unknown");
    expect(result.production_method).toBe("unknown");
    input.evidence_refs.push("later-mutation");
    expect(result.evidence_refs).toEqual(["evidence-1"]);
    expect(parseMarketObservation({ ...input, locale: "en", market: "global" }).market).toBe("global");
  });

  test.each([
    { input: null }, { input: [] }, { input: {} }, { input: "" },
    { input: { ...observation(), cookie: "sensitive-test-value" } },
  ])("rejects malformed or extra fields without echoing values", ({ input }) => {
    expect(() => parseMarketObservation(input)).toThrow();
    try { parseMarketObservation(input); } catch (error) {
      expect(String(error)).not.toContain("sensitive-test-value");
    }
  });

  test("requires evidence for country and asserted production method", () => {
    expect(() => parseMarketObservation({ ...observation(), market: "US" })).toThrow("country requires evidence");
    expect(() => parseMarketObservation({ ...observation(), production_method: "ai" })).toThrow("production method requires evidence");
    expect(parseMarketObservation({ ...observation(), market: "IN", market_evidence_refs: ["region-proof"], production_method: "ai", production_evidence_refs: ["production-proof"] }).market).toBe("IN");
  });

  test.each(["2026-02-30T00:00:00Z", "2026-09-11", "2026-09-11T25:00:00Z", "2026-09-11T00:00:00", "2026-09-11T00:00:00+08:00"])("rejects noncanonical or impossible instant %s", value => {
    expect(isMarketInstant(value)).toBe(false);
    expect(() => parseMarketObservation({ ...observation(), observed_at: value })).toThrow();
  });

  test("retains valid leap-day instants", () => {
    expect(isMarketInstant("2024-02-29T00:00:00.000Z")).toBe(true);
  });

  test("rejects malformed metrics but preserves a zero denominator for later incomparable handling", () => {
    const metric = { name: "views", value: 12, unit: "count", basis: "cumulative", window: null, definition_version: "v1", sample_denominator: 0 };
    expect(parseMarketObservation({ ...observation(), facts: [metric] }).facts[0].sample_denominator).toBe(0);
    for (const bad of [
      { ...metric, value: NaN }, { ...metric, value: Infinity }, { ...metric, value: -1 },
      { ...metric, basis: "rank", value: 0 }, { ...metric, basis: "rank", value: 1.5 },
      { ...metric, basis: "interval" }, { ...metric, sample_denominator: "10" },
      { ...metric, window: { start: "2026-09-11T01:00:00Z", end: "2026-09-11T00:00:00Z" } },
    ]) expect(() => parseMarketObservation({ ...observation(), facts: [bad] })).toThrow();
  });

  test("rejects missing evidence and unbounded titles", () => {
    expect(() => parseMarketObservation({ ...observation(), evidence_refs: [] })).toThrow();
    expect(() => parseMarketObservation({ ...observation(), title: "a".repeat(501) })).toThrow();
  });
});

describe("source and identity boundary", () => {
  const source = {
    spec: "radar.market_source.v1", source_ref: "reelshort", revision: 1,
    platform: "reelshort", role: "catalog", publisher_group: "publisher-1",
    official_identity_evidence: [], market_scope: ["global"], locale: "en",
    collection_method: "public_page", metric_definitions: [], sampling_scope: "Public homepage",
    freshness_budget: null, readiness: "planned", limitations: [],
  };

  test("keeps planned identity distinct from qualified collection", () => {
    expect(parseMarketSource(source).readiness).toBe("planned");
    expect(() => parseMarketSource({ ...source, readiness: "identity_verified" })).toThrow();
    expect(() => parseMarketSource({ ...source, readiness: "blocked" })).toThrow("blocked requires reason");
    expect(parseMarketSource({ ...source, readiness: "blocked", limitations: ["Source requires authorization"] }).readiness).toBe("blocked");
  });

  test("requires identity mapping evidence instead of merging identical titles", () => {
    const mapping = { platform_work_ref: "work-1", canonical_work_ref: null, original_title: "Same title", aliases: ["同名"], mapping_revision: 1, mapping_status: "candidate", supporting_evidence_refs: [] };
    expect(parseWorkMapping(mapping).canonical_work_ref).toBeNull();
    expect(() => parseWorkMapping({ ...mapping, mapping_status: "verified" })).toThrow();
    expect(parseWorkMapping({ ...mapping, mapping_status: "verified", canonical_work_ref: "canonical-1", supporting_evidence_refs: ["identity-proof"] }).mapping_status).toBe("verified");
  });
});
