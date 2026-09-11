import { expect, test } from "bun:test";
import { compareMetric, type ComparisonInput } from "../../src/market/comparison.ts";
import { seedSources } from "../../src/market/sources.ts";

function input(day: number, value: number, basis: "cumulative" | "rank" | "placement" = "cumulative"): ComparisonInput {
  const source = seedSources()[0];
  return {
    source, mappingVersion: "mapping-v1", windowRule: "daily-utc-v1",
    observation: {
      spec: "radar.market_observation.v1", observation_ref: "obs-" + day,
      source_ref: source.source_ref, source_revision: 1, source_item_id: "work-1",
      source_snapshot_ref: "snapshot-" + day, observed_at: "2026-09-" + day + "T00:00:00Z",
      source_published_at: null, market: "unknown", market_evidence_refs: [],
      locale: "zh", format: "unknown", production_method: "unknown", production_evidence_refs: [],
      title: "Sample", topics: [], facts: [{ name: "views", value, unit: "count", basis, window: null, definition_version: "v1", sample_denominator: null }],
      evidence_refs: ["evidence-" + day], collection_run_ref: "run-" + day, origin: "fixture",
    },
  };
}
test("uses equal adjacent increments, not growing cumulative totals", () => {
  expect(compareMetric(input(11, 110), input(12, 115), "views", input(10, 100))).toMatchObject({
    comparable: true, before: 10, after: 5, change: -5, percent_change: -50,
  });
  expect(compareMetric(input(11, 110), input(12, 115), "views")).toMatchObject({ comparable: false, code: "baseline_insufficient" });
});
test("missing history, unequal intervals and counter resets never become growth", () => {
  expect(compareMetric(null, input(12, 100), "views")).toMatchObject({ code: "baseline_insufficient" });
  expect(compareMetric(input(11, 110), input(13, 120), "views", input(10, 100))).toMatchObject({ reasons: ["unequal_observation_intervals"] });
  expect(compareMetric(input(11, 110), input(12, 5), "views", input(10, 100))).toMatchObject({ reasons: ["counter_reset"] });
});
test("sampling, mapping, source and metric revisions break comparability", () => {
  const before = input(11, 10, "rank");
  for (const change of [
    (x: ComparisonInput) => { x.source.sampling_scope = "different"; },
    (x: ComparisonInput) => { x.mappingVersion = "mapping-v2"; },
    (x: ComparisonInput) => { x.source.revision = 2; x.observation.source_revision = 2; },
    (x: ComparisonInput) => { x.observation.facts[0].definition_version = "v2"; },
    (x: ComparisonInput) => { x.observation.origin = "manual"; },
  ]) {
    const after = input(12, 5, "rank"); change(after);
    expect(compareMetric(before, after, "views")).toMatchObject({ comparable: false, reasons: ["comparison_key_changed"] });
  }
});
test("placement is not rank or audience growth, and ranks have no percentage", () => {
  expect(compareMetric(input(11, 5, "placement"), input(12, 1, "placement"), "views")).toMatchObject({
    comparable: true, claim_kind: "placement_changed", percent_change: null,
  });
  expect(compareMetric(input(11, 5, "rank"), input(12, 1, "rank"), "views")).toMatchObject({
    comparable: true, claim_kind: "rank_changed", change: -4, percent_change: null,
  });
});
test("zero baseline never yields infinity or fabricated percentage", () => {
  expect(compareMetric(input(11, 100), input(12, 115), "views", input(10, 100))).toMatchObject({
    comparable: true, before: 0, after: 15, percent_change: null,
  });
});
test("duplicate metric names and different subjects are rejected", () => {
  const after = input(12, 10, "rank");
  after.observation.facts.push({ ...after.observation.facts[0] });
  expect(compareMetric(input(11, 5, "rank"), after, "views")).toMatchObject({ reasons: ["metric_missing_or_ambiguous"] });
  after.observation.source_item_id = "different";
  expect(compareMetric(input(11, 5, "rank"), after, "views")).toMatchObject({ reasons: ["different_subject"] });
});

test("interval metrics require adjacent, complete, equally sized windows", () => {
  const before = input(11, 20), after = input(12, 30);
  before.observation.facts[0].basis = "interval";
  after.observation.facts[0].basis = "interval";
  before.observation.facts[0].window = { start: "2026-09-10T00:00:00Z", end: "2026-09-11T00:00:00Z" };
  after.observation.facts[0].window = { start: "2026-09-11T00:00:00Z", end: "2026-09-12T00:00:00Z" };
  expect(compareMetric(before, after, "views")).toMatchObject({ comparable: true, change: 10, percent_change: 50 });
  after.observation.facts[0].window.start = "2026-09-11T01:00:00Z";
  expect(compareMetric(before, after, "views")).toMatchObject({ comparable: false, reasons: ["metric_windows_not_adjacent_or_complete"] });
});
