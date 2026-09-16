import { isMarketInstant } from "../market/domain.ts";
import { MarketStoreError, marketDigest } from "../market/repository.ts";

export interface DecisionEvidence {
  ref: string;
  kind: "supply" | "demand" | "counterevidence" | "background";
  note: string;
  observed_at: string;
  url: string | null;
  source: "manual_reference" | "market_signal";
  signal_ref: string | null;
  signal_revision: number | null;
  market_evidence_ref: string | null;
  source_origin: string;
  source_digest: string | null;
}

export interface DecisionCandidate {
  ref: string;
  name: string;
  market: string;
  locale: string;
  audience: string;
  hypothesis: string;
  rationale: string;
  risk: string;
  falsifier: string;
  cost_note: string;
  evidence_refs: string[];
}

export interface DecisionBaseline {
  status: "missing" | "independent";
  note: string;
  evidence_ref: string | null;
  recorded_at: string;
  verification: "operator_attestation";
}

export interface DecisionPack {
  spec: "radar.decision_pack.v1";
  ref: string;
  revision: number;
  profile_ref: string | null;
  title: string;
  objective: string;
  topics: string[];
  evidence: DecisionEvidence[];
  candidates: DecisionCandidate[];
  baseline: DecisionBaseline | null;
  samples?: DecisionSample[];
  resume_after_sequence: number;
  resume_reason: string | null;
  created_at: string;
  updated_at: string;
  digest: string;
}

export interface ExperimentPlan {
  kind: "hypothesis" | "method";
  sample_per_arm: number;
  min_lift_pp: number;
  max_completion_drop_pp: number;
  max_failure_percent: number;
  budget_note: string;
  recruitment_note: string;
  protocol_note: string;
}

export interface DecisionExperiment {
  spec: "radar.decision_experiment.v1";
  ref: string;
  pack_ref: string;
  pack_revision: number;
  sequence: number;
  pack: DecisionPack;
  candidate_ref: string;
  control_ref: string;
  plan: ExperimentPlan;
  materials?: ExperimentMaterials;
  metric_version: "continued-15s-completed-90pct.v1";
  protocol_digest: string;
  policy_revision: string;
  locked_at: string;
  registration_scope: "local";
  digest: string;
}

export interface ArmCounts {
  assigned: number;
  continued: number;
  completed: number;
  technical_failures: number;
}

export interface ResultInput {
  materials_digest?: string;
  origin: "manual" | "fixture";
  measurement: "observed" | "intent";
  quality: "comparable" | "not_comparable";
  source_ref: string;
  started_at: string;
  finished_at: string;
  treatment: ArmCounts;
  control: ArmCounts;
  reason: string | null;
}

export interface DecisionResult extends ResultInput {
  spec: "radar.decision_result.v1";
  experiment_ref: string;
  revision: number;
  recorded_at: string;
  verification: "operator_reported";
  digest: string;
}

export function invalid(code: string, message: string): never {
  throw new MarketStoreError(code, message);
}

// Reject recognizable credential material before it can enter storage or any
// renderer. Source prose is untrusted data and never becomes an action.
export function cleanText(value: unknown, field: string, max = 2000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    invalid("decision_input_invalid", `${field} must be non-empty single-line text of at most ${max} characters.`);
  }
  if (/(?:authorization\s*:|bearer\s+\S+|(?:password|cookie|token|secret|api[_-]?key)\s*[=:]\s*\S+|-----BEGIN .*PRIVATE KEY|\bsk-[A-Za-z0-9_-]{16,})/i.test(value)) {
    invalid("sensitive_input", "Remove credential material before storing a decision input.");
  }
  return value.trim();
}

export function identifier(value: unknown, field: string): string {
  const text = cleanText(value, field, 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text)) invalid("decision_input_invalid", `${field} must be an opaque ASCII identifier.`);
  return text;
}

export function integer(value: unknown, field: string, min = 0, max = 10000): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    invalid("decision_input_invalid", `${field} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

export function choice<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) invalid("decision_input_invalid", `${field} must be ${allowed.join(" or ")}.`);
  return value as T;
}

export function refs(value: unknown, field: string, max = 64): string[] {
  if (!Array.isArray(value) || !value.length || value.length > max) invalid("decision_input_invalid", `${field} requires 1-${max} identifiers.`);
  return [...new Set(value.map(v => identifier(v, field)))].sort();
}

export function instant(value: unknown, field: string): string {
  if (!isMarketInstant(value)) invalid("decision_input_invalid", `${field} requires a canonical UTC timestamp.`);
  return new Date(value as string).toISOString();
}

export function publicUrl(value: unknown): string {
  const text = cleanText(value, "url", 2000);
  let url: URL;
  try { url = new URL(text); } catch { return invalid("decision_input_invalid", "url must be an absolute public HTTPS reference."); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash ||
    [...url.searchParams.keys()].some(k => /token|secret|key|auth|password|cookie|signature|credential/i.test(k))) {
    invalid("sensitive_input", "Use an HTTPS reference without credentials, signed parameters or fragments.");
  }
  return url.href;
}

export function candidateInput(input: DecisionCandidate): DecisionCandidate {
  const market = cleanText(input.market, "market", 7);
  if (!/^(?:unknown|global|[A-Z]{2})$/.test(market)) invalid("decision_input_invalid", "market must be a country code, global or unknown.");
  let locale: string;
  try { locale = Intl.getCanonicalLocales(cleanText(input.locale, "locale", 60))[0]!; }
  catch { return invalid("decision_input_invalid", "locale must be a valid language tag."); }
  return { ref: identifier(input.ref, "candidate"), name: cleanText(input.name, "name", 200), market, locale,
    audience: cleanText(input.audience, "audience", 500), hypothesis: cleanText(input.hypothesis, "hypothesis"),
    rationale: cleanText(input.rationale, "rationale"), risk: cleanText(input.risk, "risk"),
    falsifier: cleanText(input.falsifier, "falsifier"), cost_note: cleanText(input.cost_note, "cost_note"),
    evidence_refs: refs(input.evidence_refs, "evidence_refs") };
}

export function planInput(input: ExperimentPlan): ExperimentPlan {
  return { kind: choice(input.kind, "kind", ["hypothesis", "method"]),
    sample_per_arm: integer(input.sample_per_arm, "sample_per_arm", 1),
    min_lift_pp: integer(input.min_lift_pp, "min_lift_pp", 1, 100),
    max_completion_drop_pp: integer(input.max_completion_drop_pp, "max_completion_drop_pp", 0, 100),
    max_failure_percent: integer(input.max_failure_percent, "max_failure_percent", 0, 100),
    budget_note: cleanText(input.budget_note, "budget_note"), recruitment_note: cleanText(input.recruitment_note, "recruitment_note"),
    protocol_note: cleanText(input.protocol_note, "protocol_note") };
}

export function countsInput(input: ArmCounts): ArmCounts {
  if (!input || typeof input !== "object") invalid("decision_input_invalid", "Provide aggregate counts for both arms.");
  const assigned = integer(input.assigned, "assigned");
  return { assigned, continued: integer(input.continued, "continued", 0, assigned),
    completed: integer(input.completed, "completed", 0, assigned),
    technical_failures: integer(input.technical_failures, "technical_failures", 0, assigned) };
}

export function resultInput(input: ResultInput): ResultInput {
  return { ...(input.materials_digest === undefined ? {} : { materials_digest: digestInput(input.materials_digest) }), origin: choice(input.origin, "origin", ["manual", "fixture"]),
    measurement: choice(input.measurement, "measurement", ["observed", "intent"]),
    quality: choice(input.quality, "quality", ["comparable", "not_comparable"]),
    source_ref: identifier(input.source_ref, "source_ref"), started_at: instant(input.started_at, "started_at"),
    finished_at: instant(input.finished_at, "finished_at"), treatment: countsInput(input.treatment), control: countsInput(input.control),
    reason: input.reason === null ? null : cleanText(input.reason, "reason") };
}

export function withDigest<T extends { digest: string }>(value: T): T {
  const { digest: _, ...content } = value;
  return { ...value, digest: marketDigest(content) };
}

export function evaluateExperiment(experiment: DecisionExperiment, result: DecisionResult | null) {
  const reasons: string[] = [];
  if (!result) return { verdict: "pending" as const, reasons: ["result_missing"], lift_pp: null, completion_delta_pp: null };
  if (result.origin === "fixture") reasons.push("fixture_not_audience_evidence");
  if (result.measurement !== "observed") reasons.push("intent_is_not_watch_behavior");
  if (result.quality !== "comparable") reasons.push("quality_not_comparable");
  for (const [name, arm] of [["treatment", result.treatment], ["control", result.control]] as const) {
    if (arm.assigned !== experiment.plan.sample_per_arm) reasons.push(`${name}_sample_mismatch`);
    if (!arm.assigned || arm.technical_failures / arm.assigned * 100 > experiment.plan.max_failure_percent) reasons.push(`${name}_measurement_insufficient`);
  }
  const rate = (arm: ArmCounts, field: "continued" | "completed") => arm.assigned ? arm[field] / arm.assigned * 100 : null;
  const delta = (field: "continued" | "completed") => {
    const a = rate(result.treatment, field), b = rate(result.control, field);
    return a === null || b === null ? null : a - b;
  };
  const lift = delta("continued"), completion = delta("completed");
  if (reasons.length) return { verdict: "inconclusive" as const, reasons, lift_pp: lift, completion_delta_pp: completion };
  const passes = lift! + 1e-9 >= experiment.plan.min_lift_pp && completion! + 1e-9 >= -experiment.plan.max_completion_drop_pp;
  return { verdict: passes ? "directional_support" as const : "no_advantage" as const,
    reasons: passes ? ["configured_gate_met_not_statistical_proof"] : ["configured_gate_not_met"],
    lift_pp: lift, completion_delta_pp: completion };
}

export interface DecisionSample {
  ref: string; candidate_ref: string; artifact_ref: string; version: string;
  owner: "auctra" | "scaena" | "manual";
  episode: number; duration_seconds: number; locale: string; format: "animation" | "manga_drama";
  content_digest: string; byte_length: number;
  verification: "local_file_hash"; metadata_verification: "operator_attestation";
}
export interface ExperimentMaterials {
  spec: "radar.experiment_materials.v1";
  samples: DecisionSample[];
  allocation: "randomized" | "manual_balanced";
  recruitment_channel: string; quality_standard: string;
  digest: string;
}
export interface DecisionCancellation {
  spec: "radar.decision_cancellation.v1"; experiment_ref: string; experiment_digest: string;
  reason: string; cancelled_at: string; verification: "operator_attestation"; digest: string;
}
export function digestInput(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) invalid("decision_input_invalid", "Provide a SHA-256 content digest.");
  return value;
}
