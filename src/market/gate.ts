import { and, desc, eq, inArray } from "drizzle-orm";
import type { RadarDb } from "../db/client.ts";
import { marketEvidence, marketObservations, marketWorkGateDecisions } from "../db/schema.ts";
import { isMarketInstant, type WorkMapping } from "./domain.ts";
import { marketDigest, MarketStoreError } from "./repository.ts";
import { listWorkMappings, workMapping, workSubjectRef } from "./identity.ts";
import { reviewWorkIdentity } from "./signals.ts";

// Versioned formal-ingestion gate: candidate work mappings become canonical
// only through an explicit owner action after the current rule set passes.
// Evaluation is a deterministic read-only projection; recording a decision is
// a separate write step, and decisions are immutable once stored.

export const WORK_INGESTION_GATE_SPEC = "radar.work_ingestion_gate.v1" as const;
export const WORK_GATE_DECISION_SPEC = "radar.work_gate_decision.v1" as const;

export const GATE_REASON_CODES = [
  "identity_not_corroborated",
  "identity_ambiguous",
  "alias_conflict",
  "field_coverage_below_floor",
  "evidence_missing",
  "fixture_only_evidence",
] as const;
export type GateReasonCode = (typeof GATE_REASON_CODES)[number];

export type GateRuleId = "stable_identity" | "alias_reconciliation" | "required_field_coverage" | "evidence_floor";

export interface GateRuleSet {
  spec: typeof WORK_INGESTION_GATE_SPEC;
  gate_version: string;
  // Versioned field-set reference: which catalog fields the
  // required_field_coverage rule reads from the work's latest evidence.
  field_set: string;
  required_fields: string[];
  min_identity_batches: number;
  rules: Array<{ rule_id: GateRuleId; failure_reasons: GateReasonCode[] }>;
}

const GATE_RULES: GateRuleSet["rules"] = [
  { rule_id: "stable_identity", failure_reasons: ["identity_not_corroborated"] },
  { rule_id: "alias_reconciliation", failure_reasons: ["alias_conflict", "identity_ambiguous"] },
  { rule_id: "required_field_coverage", failure_reasons: ["field_coverage_below_floor"] },
  { rule_id: "evidence_floor", failure_reasons: ["evidence_missing", "fixture_only_evidence"] },
];

// catalog-fields.v2 is the post-cleanup hongguo field set bound after Lane A
// (radar-hongguo-catalog-parsing-v1, hongguo-anchor-layout.v1): page-own genre
// labels are trustworthy, so category joins the required floor. Decisions
// recorded under v1 keep their original meaning and are never re-judged.
export const GATE_RULE_SETS: Record<string, GateRuleSet> = {
  "work-ingestion-gate-rules.v1": {
    spec: WORK_INGESTION_GATE_SPEC,
    gate_version: "work-ingestion-gate-rules.v1",
    field_set: "catalog-fields.v1",
    required_fields: ["title", "episode_count"],
    min_identity_batches: 2,
    rules: GATE_RULES,
  },
  "work-ingestion-gate-rules.v2": {
    spec: WORK_INGESTION_GATE_SPEC,
    gate_version: "work-ingestion-gate-rules.v2",
    field_set: "catalog-fields.v2",
    required_fields: ["title", "category", "episode_count"],
    min_identity_batches: 2,
    rules: GATE_RULES,
  },
};

export const CURRENT_GATE_VERSION = "work-ingestion-gate-rules.v2";

export function gateRuleSet(gateVersion: string): GateRuleSet {
  const rules = GATE_RULE_SETS[gateVersion];
  if (!rules) {
    throw new MarketStoreError("gate_version_unknown",
      "Unknown gate version; available: " + Object.keys(GATE_RULE_SETS).sort().join(", ") + ".");
  }
  return rules;
}

// Structural validation for rule-set payloads (registry changes, fixtures,
// tests): unknown rule ids or reason codes are rejected, never silently
// carried into a new gate version.
export function parseGateRuleSet(value: unknown): GateRuleSet {
  const problem = (message: string): never => { throw new MarketStoreError("gate_rules_invalid", message); };
  if (!value || typeof value !== "object" || Array.isArray(value)) problem("Gate rule set must be an object.");
  const candidate = value as Record<string, unknown>;
  if (candidate.spec !== WORK_INGESTION_GATE_SPEC) problem("spec must be " + WORK_INGESTION_GATE_SPEC + ".");
  if (typeof candidate.gate_version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(candidate.gate_version)) problem("gate_version must be an opaque ref.");
  if (typeof candidate.field_set !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(candidate.field_set)) problem("field_set must be an opaque ref.");
  if (!Array.isArray(candidate.required_fields) || candidate.required_fields.length === 0 ||
    candidate.required_fields.some(f => typeof f !== "string" || !/^[a-z][a-z0-9_]{0,39}$/.test(f as string))) {
    problem("required_fields must be a non-empty list of field names.");
  }
  if (!Number.isSafeInteger(candidate.min_identity_batches) || (candidate.min_identity_batches as number) < 2) {
    problem("min_identity_batches must be an integer >= 2.");
  }
  if (!Array.isArray(candidate.rules) || candidate.rules.length !== GATE_RULES.length) {
    problem("rules must list exactly the registered gate rules.");
  }
  for (const [index, rule] of (candidate.rules as unknown[]).entries()) {
    const expected = GATE_RULES[index];
    if (!rule || typeof rule !== "object" || (rule as { rule_id?: unknown }).rule_id !== expected.rule_id) {
      problem("rules must keep the registered order: " + GATE_RULES.map(r => r.rule_id).join(", ") + ".");
    }
    const reasons = (rule as { failure_reasons?: unknown }).failure_reasons;
    if (!Array.isArray(reasons) || reasons.length === 0 ||
      reasons.some(code => typeof code !== "string" || !(GATE_REASON_CODES as readonly string[]).includes(code))) {
      problem("failure_reasons must be registered gate reason codes.");
    }
  }
  return structuredClone(candidate) as unknown as GateRuleSet;
}

export interface GateRuleResult {
  rule_id: GateRuleId;
  passed: boolean;
  reason_codes: GateReasonCode[];
  // Bounded, content-free explanation (counts, field names, refs); never raw
  // titles, markup or URLs beyond stored evidence refs.
  detail: Record<string, unknown>;
}

export interface GateEvaluation {
  gate_version: string;
  platform_work_ref: string;
  mapping_revision: number;
  verdict: "promotable" | "rejected";
  reason_codes: GateReasonCode[];
  rule_results: GateRuleResult[];
  evidence_refs: string[];
}

export type GateDecisionScope =
  | { kind: "single" }
  | { kind: "review_batch"; receipt_key: string }
  | { kind: "override" };

export interface WorkGateDecision extends GateEvaluation {
  spec: typeof WORK_GATE_DECISION_SPEC;
  decision_ref: string;
  evaluated_at: string;
  scope: GateDecisionScope;
  overridden: boolean;
  override_reason: string | null;
}

interface EvidenceRow { ref: string; sourceRef: string; observedAt: string; payload: {
  title: string; public_url: string; source_item_id: string; origin: string;
  category_label?: string; category_labels?: string[]; episode_count?: number;
}; }

function storedEvidence(db: RadarDb, refs: string[]): EvidenceRow[] {
  if (!refs.length) return [];
  return db.select().from(marketEvidence).where(inArray(marketEvidence.ref, refs)).all() as EvidenceRow[];
}

// The mapping's provenance: all supporting evidence must agree on one
// (source_ref, source_item_id) pair that derives back to the mapping ref.
function workProvenance(db: RadarDb, mapping: WorkMapping, evidence: EvidenceRow[]): { source_ref: string; source_item_id: string } | null {
  const pairs = new Set(evidence.map(row => row.sourceRef + "|" + row.payload.source_item_id));
  if (pairs.size !== 1) return null;
  const [source_ref, source_item_id] = [...pairs][0].split("|") as [string, string];
  return workSubjectRef(source_ref, source_item_id) === mapping.platform_work_ref ? { source_ref, source_item_id } : null;
}

function evaluateStableIdentity(db: RadarDb, mapping: WorkMapping, evidence: EvidenceRow[], rules: GateRuleSet): GateRuleResult {
  const provenance = workProvenance(db, mapping, evidence);
  if (!provenance) {
    return { rule_id: "stable_identity", passed: false, reason_codes: ["identity_not_corroborated"],
      detail: { cause: evidence.length ? "evidence_provenance_conflict" : "no_evidence" } };
  }
  const rows = db.select({ batchRef: marketObservations.batchRef, title: marketObservations.payload })
    .from(marketObservations).where(and(
      eq(marketObservations.sourceRef, provenance.source_ref),
      eq(marketObservations.itemId, provenance.source_item_id),
    )).all();
  const batches = new Set(rows.map(row => row.batchRef));
  const titles = new Set(rows.map(row => (row.title as { title: string }).title));
  // An unexplained title change across batches (for example a parser cleanup
  // re-sample) is drift the owner must reconcile, never silent corroboration.
  const drift = [...titles].some(title => title !== mapping.original_title);
  const passed = batches.size >= rules.min_identity_batches && !drift;
  return { rule_id: "stable_identity", passed, reason_codes: passed ? [] : ["identity_not_corroborated"],
    detail: { batches: batches.size, min_batches: rules.min_identity_batches, title_drift: drift } };
}

function evaluateAliasReconciliation(db: RadarDb, mapping: WorkMapping, evidence: EvidenceRow[]): GateRuleResult {
  const provenance = workProvenance(db, mapping, evidence);
  const heads = listWorkMappings(db);
  const reasons: GateReasonCode[] = [];
  const detail: Record<string, unknown> = {};
  const conflicts = heads.filter(other => other.platform_work_ref !== mapping.platform_work_ref &&
    mapping.aliases.includes(other.original_title));
  if (conflicts.length) {
    reasons.push("alias_conflict");
    detail.alias_conflicts = conflicts.length;
  }
  // Same-title works under one source stay ambiguous until the owner
  // reconciles them explicitly; the gate never merges them automatically.
  const ambiguous = heads.filter(other => other.platform_work_ref !== mapping.platform_work_ref &&
    other.original_title === mapping.original_title &&
    (!provenance || !workProvenance(db, other, storedEvidence(db, other.supporting_evidence_refs)) ||
      workProvenance(db, other, storedEvidence(db, other.supporting_evidence_refs))?.source_ref === provenance.source_ref));
  if (ambiguous.length) {
    reasons.push("identity_ambiguous");
    detail.same_title_works = ambiguous.length;
  }
  return { rule_id: "alias_reconciliation", passed: reasons.length === 0, reason_codes: reasons, detail };
}

function evaluateFieldCoverage(mapping: WorkMapping, evidence: EvidenceRow[], rules: GateRuleSet): GateRuleResult {
  // Field presence comes from the work's latest stored evidence, matching the
  // persisted quality record's per-field accounting (present/total).
  const latest = [...evidence].sort((a, b) => b.observedAt.localeCompare(a.observedAt) || b.ref.localeCompare(a.ref))[0];
  const present: string[] = [];
  const missing: string[] = [];
  for (const field of rules.required_fields) {
    const ok = !latest ? false
      : field === "title" ? typeof latest.payload.title === "string" && latest.payload.title.trim().length > 0
      : field === "category" ? (latest.payload.category_labels?.length ?? 0) > 0 || typeof latest.payload.category_label === "string"
      : field === "episode_count" ? typeof latest.payload.episode_count === "number"
      : false;
    (ok ? present : missing).push(field);
  }
  const passed = missing.length === 0;
  return { rule_id: "required_field_coverage", passed, reason_codes: passed ? [] : ["field_coverage_below_floor"],
    detail: { field_set: rules.field_set, required_fields: rules.required_fields, present, missing } };
}

function evaluateEvidenceFloor(db: RadarDb, mapping: WorkMapping, evidence: EvidenceRow[]): GateRuleResult {
  const refs = mapping.supporting_evidence_refs;
  if (!refs.length || evidence.length !== refs.length) {
    return { rule_id: "evidence_floor", passed: false, reason_codes: ["evidence_missing"],
      detail: { evidence_refs: refs.length, stored: evidence.length } };
  }
  // Fixture observations never count toward real verification; at least one
  // manual or live evidence row must back the mapping.
  if (evidence.every(row => row.payload.origin === "fixture")) {
    return { rule_id: "evidence_floor", passed: false, reason_codes: ["fixture_only_evidence"],
      detail: { evidence_refs: refs.length, origins: ["fixture"] } };
  }
  return { rule_id: "evidence_floor", passed: true, reason_codes: [],
    detail: { evidence_refs: refs.length, origins: [...new Set(evidence.map(row => row.payload.origin))].sort() } };
}

// Read-only deterministic projection: same mapping revision, stored
// observations/evidence and gate_version always produce the same result.
export function evaluateWorkGate(db: RadarDb, workRef: string, gateVersion = CURRENT_GATE_VERSION): GateEvaluation {
  const rules = gateRuleSet(gateVersion);
  const mapping = workMapping(db, workRef);
  if (!mapping) throw new MarketStoreError("identity_not_found", "No work mapping exists for this ref; import observations first.");
  const evidence = storedEvidence(db, mapping.supporting_evidence_refs);
  const rule_results = [
    evaluateStableIdentity(db, mapping, evidence, rules),
    evaluateAliasReconciliation(db, mapping, evidence),
    evaluateFieldCoverage(mapping, evidence, rules),
    evaluateEvidenceFloor(db, mapping, evidence),
  ];
  const reason_codes = [...new Set(rule_results.flatMap(result => result.reason_codes))];
  return {
    gate_version: gateVersion,
    platform_work_ref: mapping.platform_work_ref,
    mapping_revision: mapping.mapping_revision,
    verdict: reason_codes.length === 0 ? "promotable" : "rejected",
    reason_codes,
    rule_results,
    evidence_refs: mapping.supporting_evidence_refs,
  };
}

// Record an evaluation as an immutable decision. The ref is derived from the
// full content, so an identical replay returns the stored row; a genuine
// re-evaluation (new evidence, new revision or new gate_version) produces a
// new decision_ref and never rewrites the old one.
export function recordGateDecision(db: RadarDb, evaluation: GateEvaluation, scope: GateDecisionScope, evaluatedAt: string,
  override?: { reason: string }): { decision: WorkGateDecision; reused: boolean } {
  gateRuleSet(evaluation.gate_version);
  if (!isMarketInstant(evaluatedAt)) throw new MarketStoreError("time_invalid", "Gate decisions require a UTC evaluation time.");
  if (override !== undefined && (typeof override.reason !== "string" || !override.reason.trim() || override.reason.length > 500)) {
    throw new MarketStoreError("review_invalid", "An override decision requires a bounded reason text.");
  }
  const decision: WorkGateDecision = {
    spec: WORK_GATE_DECISION_SPEC,
    decision_ref: "",
    ...evaluation,
    verdict: override ? "promotable" : evaluation.verdict,
    evaluated_at: new Date(evaluatedAt).toISOString(),
    scope,
    overridden: override !== undefined,
    override_reason: override ? override.reason.trim() : null,
  };
  decision.decision_ref = "gate-decision-" + marketDigest([
    decision.platform_work_ref, decision.mapping_revision, decision.gate_version, decision.verdict,
    decision.reason_codes, decision.rule_results, decision.evidence_refs, decision.scope,
    decision.evaluated_at, decision.overridden, decision.override_reason,
  ]).slice(7, 39);
  const existing = db.select().from(marketWorkGateDecisions).where(eq(marketWorkGateDecisions.ref, decision.decision_ref)).get();
  if (existing) {
    if (marketDigest(existing.payload) !== marketDigest(decision)) {
      throw new MarketStoreError("idempotency_conflict", "Gate decision ref collides with different content; inspect the stored decision.");
    }
    return { decision: existing.payload, reused: true };
  }
  db.insert(marketWorkGateDecisions).values({
    ref: decision.decision_ref, workRef: decision.platform_work_ref, mappingRevision: decision.mapping_revision,
    gateVersion: decision.gate_version, verdict: decision.verdict, evaluatedAt: decision.evaluated_at, payload: decision,
  }).run();
  return { decision, reused: false };
}

export function evaluateAndRecordGate(db: RadarDb, workRef: string, scope: GateDecisionScope, now = new Date(),
  gateVersion = CURRENT_GATE_VERSION): { decision: WorkGateDecision; reused: boolean } {
  return recordGateDecision(db, evaluateWorkGate(db, workRef, gateVersion), scope, now.toISOString());
}

export function gateDecisionsForWork(db: RadarDb, workRef: string, gateVersion?: string): WorkGateDecision[] {
  if (gateVersion !== undefined) gateRuleSet(gateVersion);
  return db.select().from(marketWorkGateDecisions).where(and(
    eq(marketWorkGateDecisions.workRef, workRef),
    ...(gateVersion === undefined ? [] : [eq(marketWorkGateDecisions.gateVersion, gateVersion)]),
  )).orderBy(marketWorkGateDecisions.evaluatedAt, marketWorkGateDecisions.ref).all().map(row => row.payload);
}

// Latest decision under one gate version, regardless of the revision it
// targets; promote uses this to distinguish "never evaluated" from "stale".
export function latestGateDecision(db: RadarDb, workRef: string, gateVersion = CURRENT_GATE_VERSION): WorkGateDecision | null {
  gateRuleSet(gateVersion);
  return db.select().from(marketWorkGateDecisions).where(and(
    eq(marketWorkGateDecisions.workRef, workRef), eq(marketWorkGateDecisions.gateVersion, gateVersion),
  )).orderBy(desc(marketWorkGateDecisions.evaluatedAt), desc(marketWorkGateDecisions.ref)).limit(1).get()?.payload ?? null;
}

// The operative decision is bound to the current head revision: advancing the
// mapping invalidates older decisions without rewriting them.
export function operativeGateDecision(db: RadarDb, workRef: string, gateVersion = CURRENT_GATE_VERSION): WorkGateDecision | null {
  const head = workMapping(db, workRef);
  if (!head) return null;
  const latest = latestGateDecision(db, workRef, gateVersion);
  return latest && latest.mapping_revision === head.mapping_revision ? latest : null;
}

export interface PromoteResult {
  mapping: WorkMapping;
  reused: boolean;
  identity_changed: boolean;
  signal_revisions: Array<{ ref: string; revision: number }>;
  gate_decision_ref: string | null;
  overridden: boolean;
}

// Gated canonical promotion. The default path requires an operative
// promotable decision; an explicit owner override bypasses the gate but
// records an auditable overridden decision in the same transaction. The
// canonical write itself reuses reviewWorkIdentity, so verified mappings keep
// the signal-correction chain and are never demoted by later observations.
export function promoteWork(db: RadarDb, input: {
  work: string; expected_revision: number; canonical_work_ref: string; evidence_refs: string[]; override_reason?: string;
}, now = new Date()): PromoteResult {
  if (!Number.isFinite(now.getTime())) throw new MarketStoreError("review_invalid", "Promote requires a valid review time.");
  if (input.override_reason !== undefined &&
    (typeof input.override_reason !== "string" || !input.override_reason.trim() || input.override_reason.length > 500)) {
    throw new MarketStoreError("review_invalid", "--override-reason must be a non-empty reason of at most 500 characters.");
  }
  return db.transaction(tx => {
    const head = workMapping(tx, input.work);
    if (!head) throw new MarketStoreError("identity_not_found", "No work mapping exists for this ref; import observations first.");
    if (head.mapping_revision !== input.expected_revision) {
      throw new MarketStoreError("state_conflict", "Work mapping revision changed; read the current mapping before promoting.");
    }
    let gateDecisionRef: string | null = null;
    let overridden = false;
    const latest = latestGateDecision(tx, input.work, CURRENT_GATE_VERSION);
    if (input.override_reason === undefined) {
      if (!latest) {
        throw new MarketStoreError("gate_not_passed",
          "No gate decision exists under " + CURRENT_GATE_VERSION + "; run 'radar market work review-batch' or 'radar market work gate report' first.");
      }
      if (latest.mapping_revision !== head.mapping_revision) {
        throw new MarketStoreError("stale_gate_decision",
          "The latest gate decision targets mapping revision " + latest.mapping_revision + " but the head is " + head.mapping_revision + "; re-evaluate before promoting.");
      }
      if (latest.verdict !== "promotable") {
        throw new MarketStoreError("gate_not_passed",
          "Latest gate decision is rejected (" + latest.reason_codes.join(", ") + "); see 'radar market work gate report' or promote with --override-reason.");
      }
      gateDecisionRef = latest.decision_ref;
    } else {
      // The override decision keeps the real rule results but forces a
      // promotable verdict with the owner reason attached for audit.
      const recorded = recordGateDecision(tx, evaluateWorkGate(tx, input.work, CURRENT_GATE_VERSION),
        { kind: "override" }, now.toISOString(), { reason: input.override_reason });
      gateDecisionRef = recorded.decision.decision_ref;
      overridden = true;
    }
    const review = reviewWorkIdentity(tx, {
      work: input.work, expected_revision: input.expected_revision,
      canonical_work_ref: input.canonical_work_ref, evidence_refs: input.evidence_refs,
    }, now);
    return { mapping: review.mapping, reused: review.reused, identity_changed: review.identity_changed,
      signal_revisions: review.signal_revisions, gate_decision_ref: gateDecisionRef, overridden };
  }, { behavior: "immediate" });
}
