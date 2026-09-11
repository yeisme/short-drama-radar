import { marketDigest } from "./repository.ts";
import { parseMarketObservation, parseMarketSource, type MarketObservation, type MarketSource, type MetricFact } from "./domain.ts";

export interface ComparisonInput {
  observation: MarketObservation;
  source: MarketSource;
  mappingVersion: string;
  windowRule: string;
}

export type ComparisonResult =
  | { comparable: false; code: "baseline_insufficient" | "metric_incomparable"; reasons: string[] }
  | { comparable: true; comparison_key: string; claim_kind: "metric_changed" | "rank_changed" | "placement_changed";
      before: number; after: number; change: number; percent_change: number | null;
      window: { start: string; end: string }; evidence_refs: string[]; limitations: string[] };

function metric(input: ComparisonInput, name: string): MetricFact | undefined {
  const matches = input.observation.facts.filter(f => f.name === name);
  return matches.length === 1 ? matches[0] : undefined;
}

function contextKey(input: ComparisonInput, fact: MetricFact): string {
  return marketDigest({
    source: input.source.source_ref, revision: input.source.revision,
    market: input.observation.market, sampling_scope: input.source.sampling_scope,
    definition: fact.definition_version, metric: fact.name, unit: fact.unit, basis: fact.basis,
    mapping: input.mappingVersion, windowRule: input.windowRule, origin: input.observation.origin,
  });
}

function validate(input: ComparisonInput): void {
  parseMarketObservation(input.observation);
  parseMarketSource(input.source);
}

function incompatible(...reasons: string[]): ComparisonResult {
  return { comparable: false, code: "metric_incomparable", reasons };
}

// Cumulative totals need THREE observations: two adjacent equal-duration
// increments. Comparing just two lifetime totals would imply demand growth
// merely because a counter can only increase.
export function compareMetric(before: ComparisonInput | null, after: ComparisonInput, name: string, baseline?: ComparisonInput): ComparisonResult {
  validate(after);
  if (!before) return { comparable: false, code: "baseline_insufficient", reasons: ["previous_observation_missing"] };
  validate(before);
  const inputs = baseline ? [baseline, before, after] : [before, after];
  if (baseline) validate(baseline);
  if (inputs.some(i => !i.mappingVersion || !i.windowRule ||
    i.observation.source_ref !== i.source.source_ref || i.observation.source_revision !== i.source.revision)) {
    return incompatible("source_or_rule_binding_invalid");
  }
  if (inputs.some(i => i.observation.source_item_id !== after.observation.source_item_id)) return incompatible("different_subject");
  const facts = inputs.map(i => metric(i, name));
  if (facts.some(f => !f)) return incompatible("metric_missing_or_ambiguous");
  const af = metric(after, name)!;
  const bf = metric(before, name)!;
  const key = contextKey(after, af);
  if (inputs.some((i, n) => contextKey(i, facts[n]!) !== key)) return incompatible("comparison_key_changed");
  const start = Date.parse(before.observation.observed_at);
  const end = Date.parse(after.observation.observed_at);
  if (start >= end) return incompatible("observation_window_not_increasing");
  let previous = bf.value;
  let current = af.value;
  let percent: number | null = null;
  const limitations: string[] = [];
  if (af.basis === "cumulative") {
    if (!baseline) return { comparable: false, code: "baseline_insufficient", reasons: ["two_intervals_required"] };
    const baseTime = Date.parse(baseline.observation.observed_at);
    if (start - baseTime !== end - start) return incompatible("unequal_observation_intervals");
    previous = bf.value - metric(baseline, name)!.value;
    current = af.value - bf.value;
    if (previous < 0 || current < 0) return incompatible("counter_reset");
    limitations.push("Changes compare adjacent observed increments, not total market demand.");
  } else if (af.basis === "interval") {
    if (!af.window || !bf.window) return incompatible("metric_window_missing");
    const aStart = Date.parse(af.window.start), aEnd = Date.parse(af.window.end);
    const bStart = Date.parse(bf.window.start), bEnd = Date.parse(bf.window.end);
    if (aEnd - aStart !== bEnd - bStart || bEnd !== aStart || aEnd > end || bEnd > start) {
      return incompatible("metric_windows_not_adjacent_or_complete");
    }
  }
  if (af.basis === "rank" || af.basis === "placement") {
    limitations.push(af.basis === "placement" ? "Editorial placement is not measured popularity." : "Position change applies only to this source ranking.");
  } else if (previous > 0 && bf.sample_denominator !== 0 && af.sample_denominator !== 0) {
    percent = ((current - previous) / previous) * 100;
    if (!Number.isFinite(percent)) percent = null;
  } else {
    limitations.push("Percentage unavailable because the baseline or sample denominator is zero.");
  }
  if (!Number.isFinite(current - previous)) return incompatible("numeric_overflow");
  return {
    comparable: true, comparison_key: key,
    claim_kind: af.basis === "rank" ? "rank_changed" : af.basis === "placement" ? "placement_changed" : "metric_changed",
    before: previous, after: current, change: current - previous, percent_change: percent,
    window: { start: before.observation.observed_at, end: after.observation.observed_at },
    evidence_refs: [...new Set(inputs.flatMap(i => i.observation.evidence_refs))], limitations,
  };
}
