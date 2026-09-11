// Market observations are additive: the legacy two-platform card contract
// must never acquire global platforms or different metric semantics.
export const MARKET_OBSERVATION_SPEC = "radar.market_observation.v1" as const;
export const MARKET_SOURCE_SPEC = "radar.market_source.v1" as const;

export type Market = "global" | "unknown" | Uppercase<string>;
export type ContentFormat = "live_action" | "animation" | "mixed" | "unknown";
export type ProductionMethod = "ai" | "non_ai" | "mixed" | "unknown";
export type SourceReadiness = "planned" | "identity_verified" | "sample_verified" | "qualified" | "blocked";
export type SourceHealth = "fresh" | "stale" | "partial" | "unavailable" | "freshness_unknown";

export interface MetricFact {
  name: string;
  value: number;
  unit: string;
  basis: "cumulative" | "interval" | "rank" | "placement";
  window: { start: string; end: string } | null;
  definition_version: string;
  sample_denominator: number | null;
}

export interface MarketSource {
  spec: typeof MARKET_SOURCE_SPEC;
  source_ref: string;
  revision: number;
  platform: string;
  role: "catalog" | "discussion" | "industry";
  publisher_group: string;
  official_identity_evidence: string[];
  market_scope: Market[];
  locale: string;
  collection_method: "public_page" | "authorized_adapter" | "manual";
  metric_definitions: string[];
  sampling_scope: string;
  freshness_budget: number | null; // Seconds; null means unknown, never fresh.
  readiness: SourceReadiness;
  limitations: string[];
}

export interface MarketObservation {
  spec: typeof MARKET_OBSERVATION_SPEC;
  observation_ref: string;
  source_ref: string;
  source_revision: number;
  source_item_id: string;
  source_snapshot_ref: string;
  observed_at: string;
  source_published_at: string | null;
  market: Market;
  market_evidence_refs: string[];
  locale: string;
  format: ContentFormat;
  production_method: ProductionMethod;
  production_evidence_refs: string[];
  title: string;
  topics: string[];
  facts: MetricFact[];
  evidence_refs: string[];
  collection_run_ref: string;
  origin: "fixture" | "manual" | "live";
}

export interface WorkMapping {
  platform_work_ref: string;
  canonical_work_ref: string | null;
  original_title: string;
  aliases: string[];
  mapping_revision: number;
  mapping_status: "candidate" | "verified";
  supporting_evidence_refs: string[];
}

export class MarketValidationError extends Error {
  readonly code = "observation_invalid";
  constructor(public readonly problems: string[]) {
    // Errors expose field names, not rejected input or potentially secret values.
    super("Invalid market input: " + problems.join("; "));
    this.name = "MarketValidationError";
  }
}

type Check = (value: unknown) => boolean;
const text: Check = v => typeof v === "string" && v.trim().length > 0 && v.length <= 500 && !/[\u0000-\u001f\u007f]/u.test(v);
const ref: Check = v => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(v);
const positiveInteger: Check = v => Number.isSafeInteger(v) && (v as number) > 0;
const nonnegative: Check = v => typeof v === "number" && Number.isFinite(v) && v >= 0;
const nullable = (check: Check): Check => v => v === null || check(v);
const list = (check: Check, max = 100): Check => v => Array.isArray(v) && v.length <= max && v.every(check);
const choice = (...values: string[]): Check => v => typeof v === "string" && values.includes(v);
const market: Check = v => typeof v === "string" && /^(?:global|unknown|[A-Z]{2})$/.test(v);
const locale: Check = v => {
  if (v === "unknown") return true;
  if (typeof v !== "string" || v.length > 60) return false;
  try { return Intl.getCanonicalLocales(v).length === 1; } catch { return false; }
};

// Require canonical UTC instants. Date.parse alone accepts overflow dates
// (for example February 30), which would silently move observation windows.
export const isMarketInstant: Check = v => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(v)) return false;
  const n = Date.parse(v);
  return Number.isFinite(n) && new Date(n).toISOString() === (v.includes(".") ? v : v.replace("Z", ".000Z"));
};

function fields(value: unknown, shape: Record<string, Check>, path: string): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [path + ": expected object"];
  const object = value as Record<string, unknown>;
  const problems = Object.entries(shape)
    .filter(([key, check]) => !Object.hasOwn(object, key) || !check(object[key]))
    .map(([key]) => path + "." + key + ": invalid or missing");
  if (Object.keys(object).some(key => !Object.hasOwn(shape, key))) problems.push(path + ": unknown fields");
  return problems;
}

function metricProblems(value: unknown): string[] {
  const problems = fields(value, {
    name: ref, value: nonnegative, unit: ref,
    basis: choice("cumulative", "interval", "rank", "placement"),
    window: nullable(v => fields(v, { start: isMarketInstant, end: isMarketInstant }, "window").length === 0),
    definition_version: ref, sample_denominator: nullable(nonnegative),
  }, "metric");
  if (problems.length) return problems;
  const m = value as MetricFact;
  if (m.basis === "interval" && m.window === null) problems.push("metric.window: interval requires window");
  if (m.window && Date.parse(m.window.start) >= Date.parse(m.window.end)) problems.push("metric.window: must increase");
  if ((m.basis === "rank" || m.basis === "placement") && !positiveInteger(m.value)) problems.push("metric.value: position must be a positive integer");
  return problems;
}

export function parseMarketObservation(value: unknown): MarketObservation {
  const problems = fields(value, {
    spec: choice(MARKET_OBSERVATION_SPEC), observation_ref: ref, source_ref: ref,
    source_revision: positiveInteger, source_item_id: ref, source_snapshot_ref: ref,
    observed_at: isMarketInstant, source_published_at: nullable(isMarketInstant),
    market, market_evidence_refs: list(ref), locale,
    format: choice("live_action", "animation", "mixed", "unknown"),
    production_method: choice("ai", "non_ai", "mixed", "unknown"),
    production_evidence_refs: list(ref), title: text, topics: list(ref),
    facts: list(v => metricProblems(v).length === 0),
    evidence_refs: v => list(ref)(v) && (v as unknown[]).length > 0,
    collection_run_ref: ref, origin: choice("fixture", "manual", "live"),
  }, "observation");
  if (problems.length) throw new MarketValidationError(problems);
  const o = value as MarketObservation;
  if (o.market !== "global" && o.market !== "unknown" && o.market_evidence_refs.length === 0) problems.push("observation.market_evidence_refs: country requires evidence");
  if (o.production_method !== "unknown" && o.production_evidence_refs.length === 0) problems.push("observation.production_evidence_refs: production method requires evidence");
  if (problems.length) throw new MarketValidationError(problems);
  // Copy the validated payload: callers must not mutate an accepted batch
  // through their original input while a repository is committing it.
  return structuredClone(o);
}

export function parseMarketSource(value: unknown): MarketSource {
  const problems = fields(value, {
    spec: choice(MARKET_SOURCE_SPEC), source_ref: ref, revision: positiveInteger,
    platform: ref, role: choice("catalog", "discussion", "industry"), publisher_group: ref,
    official_identity_evidence: list(ref),
    market_scope: v => list(market)(v) && (v as unknown[]).length > 0, locale,
    collection_method: choice("public_page", "authorized_adapter", "manual"),
    metric_definitions: list(ref), sampling_scope: text,
    freshness_budget: nullable(positiveInteger),
    readiness: choice("planned", "identity_verified", "sample_verified", "qualified", "blocked"),
    limitations: list(text),
  }, "source");
  if (problems.length) throw new MarketValidationError(problems);
  const source = value as MarketSource;
  if (["identity_verified", "sample_verified", "qualified"].includes(source.readiness) && source.official_identity_evidence.length === 0) problems.push("source.official_identity_evidence: qualification requires identity");
  if (source.readiness === "blocked" && source.limitations.length === 0) problems.push("source.limitations: blocked requires reason");
  if (problems.length) throw new MarketValidationError(problems);
  // Qualified readiness is also checked against stored history by the
  // qualification service; structural validation is not promotion authority.
  return structuredClone(source);
}

export function parseWorkMapping(value: unknown): WorkMapping {
  const problems = fields(value, {
    platform_work_ref: ref, canonical_work_ref: nullable(ref), original_title: text,
    aliases: list(text), mapping_revision: positiveInteger,
    mapping_status: choice("candidate", "verified"), supporting_evidence_refs: list(ref),
  }, "mapping");
  if (problems.length) throw new MarketValidationError(problems);
  const mapping = value as WorkMapping;
  if (mapping.mapping_status === "verified" && (!mapping.canonical_work_ref || mapping.supporting_evidence_refs.length === 0)) {
    throw new MarketValidationError(["mapping: verified identity requires canonical ref and evidence"]);
  }
  return structuredClone(mapping);
}
