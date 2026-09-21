import { eq, like } from "drizzle-orm";
import type { RadarDb } from "../db/client.ts";
import { readingJudgments } from "../db/schema.ts";
import { listChineseReading, type ChineseLocale } from "../market/translation.ts";
import { ProfileService } from "../profile/service.ts";
import {
  EVALUATE_OP,
  JUDGMENT_SCHEMA_VERSION,
  JudgmentError,
  classifySubmissionFailure,
  requestInputDigest,
  validateJudgmentRequest,
  validateJudgmentResult,
  type JudgmentRequest,
  type JudgmentResult,
  type JudgmentResultItem,
} from "./contract.ts";
import {
  READING_JUDGMENT_POLICY,
  READING_QUESTIONS,
  type QuestionId,
} from "./questionset.ts";
import {
  PROJECTION_LIMITS,
  projectEditionForJudgment,
  projectReadingForJudgment,
  toReadingProjectionItems,
  type ProjectionCandidate,
  type ReadingProjection,
} from "./projection.ts";
import type { JudgmentTransport } from "./transport.ts";

// Optional SDK consumer for advisory reading judgments. Default is off:
// zero discovery, zero transport calls, zero writes. Shadow and assist are
// explicit opt-in modes; both still run every deterministic gate first. The
// consumer sends exactly one evaluate per new attempt, never auto-retries an
// unknown outcome, and replays stored evidence with zero network.

export const READING_JUDGMENT_SPEC = "radar.reading_judgment.v1" as const;

export type JudgmentMode = "off" | "shadow" | "assist";

export class JudgmentConsumerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "JudgmentConsumerError";
  }
}

export function parseJudgmentMode(value: string | undefined): JudgmentMode {
  if (value === undefined) return "off";
  if (value === "off" || value === "shadow" || value === "assist") return value;
  throw new JudgmentConsumerError("mode_invalid", "Mode must be off, shadow or assist; shadow and assist are explicit opt-ins and never defaults.");
}

export interface SanitizedItem {
  candidate_id: string;
  question_id: QuestionId | string;
  answer_status: "answered" | "abstained" | "error";
  value: JudgmentResultItem["value"];
  confidence: { value: number; provenance: string } | null;
  probability_true: number | null;
  reason_code: string | null;
}

export interface ReadingSuggestion {
  candidate_id: string;
  binding_kind: "edition_entry" | "reading_item";
  ref: string; // opportunity ref or work ref (owner-side, never model output)
  relevance: "relevant" | "partially_relevant" | "not_relevant" | null;
  duplicate: boolean | null;
  needs_verification: boolean | null; // model view; deterministic flags stay separate
  adoptable: boolean;
  blockers: string[];
  handoff: { surface: "edition" | "reading_list" | "market_brief"; commands: string[] };
  advisory_only: true;
}

export interface BaselineComparison {
  kind: "deterministic_order";
  baseline_order: string[];
  suggested_order: string[];
  retained: number;
  added: number;
  note: string;
}

export interface ReadingJudgmentRecord {
  spec: typeof READING_JUDGMENT_SPEC;
  attempt_key: string;
  request_id: string;
  attempt_id: string;
  mode: JudgmentMode;
  target: { kind: "edition" | "reading"; edition_ref?: string; language?: ChineseLocale };
  created_at: string;
  question_set: { id: string; version: string; digest: string };
  policy: { id: string; version: string; digest: string };
  model: { transport: string; requested_model: string | null; resolved_model: string | null; adapter: string | null };
  input_digest: string;
  wire_input_bytes: number;
  bindings: {
    authorization: ReadingProjection["authorization"];
    candidates: ProjectionCandidate[];
    edition_digest?: string;
  };
  execution_status: "succeeded" | "partial" | "failed" | "unknown" | "precheck_rejected";
  items: SanitizedItem[];
  suggestions: ReadingSuggestion[];
  baseline: BaselineComparison | null;
  usage: unknown;
  latency_ms: number | null;
  provider_request_id: string | null;
  error: { code: string; submission_state: string; retry_class: string } | null;
  limitations: string[];
  accepted: null | { kind: string; review_refs: string[]; accepted_at: string };
}

export type JudgmentTarget =
  | { kind: "edition"; profileRef?: string; editionRef?: string }
  | { kind: "reading"; language: ChineseLocale };

export interface EvaluateOutcome {
  outcome: "off" | "precheck_rejected" | "replayed" | "failed" | "evaluated";
  mode: JudgmentMode;
  record: ReadingJudgmentRecord | null; // null only in off mode (no writes at all)
  reused: boolean;
  transport_evaluate_calls: number;
}

const RELEVANCE_RANK: Record<string, number> = { relevant: 0, partially_relevant: 1, not_relevant: 2 };

export async function evaluateReadingJudgment(
  db: RadarDb,
  input: {
    mode: JudgmentMode;
    transport: JudgmentTransport;
    target: JudgmentTarget;
    fresh?: boolean; // explicit new attempt; replays never happen implicitly the other way either
    now?: Date;
  },
): Promise<EvaluateOutcome> {
  if (input.mode === "off") {
    // Off keeps commands, defaults, data and budget exactly as they were.
    return { outcome: "off", mode: "off", record: null, reused: false, transport_evaluate_calls: 0 };
  }
  const now = input.now ?? new Date();
  const projection = projectTarget(db, input.target);

  const admitted = projection.candidates.filter((c) => c.deterministic.admitted);
  if (admitted.length === 0) {
    const base = baseRecord(projection, input.mode, now);
    const attemptNo = priorAttempts(db, `rj-${projection.target}-${projection.input_digest.slice(7, 25)}`).length + 1;
    const record = persist(db, {
      ...base,
      attempt_key: `rj-${projection.target}-${projection.input_digest.slice(7, 25)}-a${attemptNo}`,
      request_id: `rj-${projection.target}-${projection.input_digest.slice(7, 25)}`,
      attempt_id: `rj-${projection.target}-${projection.input_digest.slice(7, 25)}-a${attemptNo}`,
      execution_status: "precheck_rejected",
      error: null,
      limitations: [...projection.context.limitations, "deterministic pre-checks rejected every candidate; no model call was made"],
    });
    return { outcome: "precheck_rejected", mode: input.mode, record, reused: false, transport_evaluate_calls: 0 };
  }

  const request = buildWireRequest(projection, admitted);
  const inputDigest = requestInputDigest(request);
  const baseKey = `rj-${projection.target}-${inputDigest.slice(7, 25)}`;
  const prior = priorAttempts(db, baseKey).filter((row) => row.payload.input_digest === inputDigest);
  if (!input.fresh && prior.length > 0) {
    // Zero-network replay of already-saved evidence, including failed and
    // unknown attempts — a fresh attempt must be requested explicitly.
    return { outcome: "replayed", mode: input.mode, record: prior[0]!.payload, reused: true, transport_evaluate_calls: 0 };
  }
  const attemptNo = priorAttempts(db, baseKey).length + 1;
  const requestId = baseKey;
  const attemptId = `${baseKey}-a${attemptNo}`;
  const requestWithIds: JudgmentRequest = { ...request, request_id: requestId, attempt_id: attemptId };
  const problems = validateJudgmentRequest(requestWithIds);
  if (problems.length > 0) throw new JudgmentConsumerError("request_invalid", problems.join("; "));

  const base = { ...baseRecord(projection, input.mode, now), attempt_key: `${baseKey}-a${attemptNo}`, request_id: requestId, attempt_id: attemptId, input_digest: inputDigest, wire_input_bytes: JSON.stringify(requestWithIds).length };

  // Capability precheck happens before any evaluate: unsupported schema,
  // modality or primitive is rejected here, pointing back at the domain flow.
  let capabilities;
  try {
    capabilities = await input.transport.describeCapabilities();
  } catch (error) {
    const classified = classifySubmissionFailure(error);
    return failed(db, base, input.transport, classified);
  }
  const selection = selectModel(capabilities, requestWithIds);
  if (selection.problems.length > 0) {
    const classified = new JudgmentError("unsupported_capability", selection.problems.join("; "), "not_submitted", "never", "capability-precheck");
    return failed(db, base, input.transport, classified);
  }
  base.model.requested_model = requestWithIds.model.requested_model;
  base.model.resolved_model = selection.model!.model;
  base.model.adapter = capabilities.adapter;

  let result: JudgmentResult;
  try {
    result = await input.transport.evaluate(requestWithIds);
  } catch (error) {
    const classified = classifySubmissionFailure(error);
    return failed(db, base, input.transport, classified);
  }

  const validation = validateJudgmentResult(requestWithIds, result, READING_JUDGMENT_POLICY.distribution_sum_tolerance);
  if (!validation.valid) {
    const classified = new JudgmentError("invalid_response", validation.problems.slice(0, 5).join("; "), "unknown", "never", "result-validation");
    return failed(db, base, input.transport, classified);
  }

  const items = sanitizeItems(result);
  const suggestions = buildSuggestions(projection, admitted, validation.byPair);
  const baseline = compareWithBaseline(projection, admitted, suggestions);
  const record = persist(db, {
    ...base,
    model: { ...base.model, resolved_model: result.resolved_model?.model ?? selection.model!.model },
    execution_status: result.execution_status,
    items,
    suggestions,
    baseline,
    usage: result.usage ?? null,
    latency_ms: result.latency_ms ?? null,
    provider_request_id: result.provider_request_id ?? null,
    error: null,
    limitations: [...projection.context.limitations, "advisory suggestions only; deterministic rules and human review stay authoritative"],
  });
  return { outcome: "evaluated", mode: input.mode, record, reused: false, transport_evaluate_calls: 1 };
}

function projectTarget(db: RadarDb, target: JudgmentTarget): ReadingProjection {
  if (target.kind === "edition") {
    const profiles = new ProfileService(db);
    const profile = profiles.show(target.profileRef);
    return projectEditionForJudgment(db, profile, target.editionRef);
  }
  const list = listChineseReading(db, { language: target.language });
  return projectReadingForJudgment(db, target.language, toReadingProjectionItems(list), list.omitted);
}

function baseRecord(projection: ReadingProjection, mode: JudgmentMode, now: Date): ReadingJudgmentRecord {
  return {
    spec: READING_JUDGMENT_SPEC,
    attempt_key: "",
    request_id: "",
    attempt_id: "",
    mode,
    target: projection.target === "edition"
      ? { kind: "edition", edition_ref: projection.context.edition_ref }
      : { kind: "reading", language: projection.context.language as ChineseLocale },
    created_at: now.toISOString(),
    question_set: projection.question_set,
    policy: projection.policy,
    model: { transport: "", requested_model: null, resolved_model: null, adapter: null },
    input_digest: projection.input_digest,
    wire_input_bytes: 0,
    bindings: {
      authorization: projection.authorization,
      candidates: projection.candidates,
      ...(projection.context.edition_digest ? { edition_digest: projection.context.edition_digest } : {}),
    },
    execution_status: "unknown",
    items: [],
    suggestions: [],
    baseline: null,
    usage: null,
    latency_ms: null,
    provider_request_id: null,
    error: null,
    limitations: projection.context.limitations,
    accepted: null,
  };
}

function failed(
  db: RadarDb,
  base: ReadingJudgmentRecord,
  transport: JudgmentTransport,
  classified: JudgmentError,
): EvaluateOutcome {
  const record = persist(db, {
    ...base,
    model: { transport: transport.transport, requested_model: base.model.requested_model, resolved_model: null, adapter: base.model.adapter },
    execution_status: classified.code === "outcome_unknown" ? "unknown" : "failed",
    error: { code: classified.code, submission_state: classified.submission_state, retry_class: classified.retry_class },
    limitations: [...base.limitations, "no adoptable suggestion was produced; the original flow is unaffected"],
  });
  return { outcome: "failed", mode: base.mode, record, reused: false, transport_evaluate_calls: 0 };
}

function selectModel(
  capabilities: { schema_version: string; models: Array<{ model: string; modalities: string[]; primitives: string[] }>; max_batch_candidates: number; max_questions: number; max_input_bytes: number },
  request: JudgmentRequest,
): { model: { model: string; modalities: string[]; primitives: string[] } | null; problems: string[] } {
  const problems: string[] = [];
  if (capabilities.schema_version !== JUDGMENT_SCHEMA_VERSION) problems.push(`transport speaks schema_version '${capabilities.schema_version}', not '1.0'`);
  const needed = [...new Set(request.questions.map((q) => q.primitive.kind))];
  const model = capabilities.models.find((m) => needed.every((p) => m.primitives.includes(p as never)) && m.modalities.includes("text")) ?? null;
  if (!model) problems.push("no advertised model supports the required text primitives");
  if (request.candidates.length > capabilities.max_batch_candidates) problems.push("request exceeds the transport candidate batch cap");
  if (request.questions.length > capabilities.max_questions) problems.push("request exceeds the transport question cap");
  if (request.sources.reduce((sum, s) => sum + s.inline_text.length, 0) > capabilities.max_input_bytes) problems.push("request exceeds the transport input byte cap");
  return { model, problems };
}

function buildWireRequest(projection: ReadingProjection, admitted: ProjectionCandidate[]): JudgmentRequest {
  const candidateIds = admitted.map((c) => c.candidate_id);
  return {
    schema_version: JUDGMENT_SCHEMA_VERSION,
    request_id: "", // assigned with the attempt below
    attempt_id: "",
    scope: projection.scope,
    model: { transport_provider: "injected", model_provider: "unresolved", requested_model: "declared-by-capabilities" },
    question_set: projection.question_set,
    policy_ref: projection.policy,
    sources: projection.sources.map((s) => ({ source_id: s.source_id, revision: s.revision, digest: s.digest, inline_text: s.inline_text, language: s.language })),
    candidates: admitted.map((c) => ({ candidate_id: c.candidate_id, source_ids: c.source_ids })),
    questions: READING_QUESTIONS.map((question) => ({
      question_id: question.question_id,
      primitive: question.primitive,
      question_text: question.question_text,
      candidate_ids: candidateIds,
      required: question.required,
    })),
    limits: {
      deadline_ms: 30_000,
      max_candidates: PROJECTION_LIMITS.max_candidates,
      max_questions: PROJECTION_LIMITS.max_questions,
      max_input_bytes: PROJECTION_LIMITS.max_input_bytes,
      max_output_bytes: 64_000,
    },
  };
}

function sanitizeItems(result: JudgmentResult): SanitizedItem[] {
  return result.items.map((item) => ({
    candidate_id: item.candidate_id,
    question_id: item.question_id,
    answer_status: item.answer_status,
    value: item.answer_status === "answered" ? item.value : null,
    confidence: item.confidence ?? null,
    probability_true: item.probability_true ?? null,
    reason_code: item.reason_code ?? null,
  }));
}

function buildSuggestions(projection: ReadingProjection, admitted: ProjectionCandidate[], byPair: Map<string, JudgmentResultItem>): ReadingSuggestion[] {
  return admitted.map((candidate) => {
    const answer = (questionId: string) => byPair.get(`${candidate.candidate_id} ${questionId}`);
    const relevanceItem = answer("morning_relevance");
    const duplicateItem = answer("reading_duplicate");
    const verificationItem = answer("needs_verification");
    const relevance = relevanceItem?.answer_status === "answered" && relevanceItem.value && "option_id" in relevanceItem.value
      ? (relevanceItem.value.option_id as ReadingSuggestion["relevance"])
      : null;
    const duplicate = duplicateItem?.answer_status === "answered" && duplicateItem.value && "binary" in duplicateItem.value
      ? duplicateItem.value.binary
      : null;
    const needsVerification = verificationItem?.answer_status === "answered" && verificationItem.value && "binary" in verificationItem.value
      ? verificationItem.value.binary
      : null;
    const blockers: string[] = [];
    for (const question of READING_QUESTIONS) {
      if (!question.required) continue;
      const item = answer(question.question_id);
      if (!item || item.answer_status !== "answered") blockers.push(`required_answer_missing:${question.question_id}`);
    }
    const binding = candidate.binding;
    return {
      candidate_id: candidate.candidate_id,
      binding_kind: binding.kind,
      ref: binding.kind === "edition_entry" ? binding.opportunity_ref : binding.work_ref,
      relevance,
      duplicate,
      needs_verification: needsVerification,
      adoptable: blockers.length === 0,
      blockers,
      handoff: binding.kind === "edition_entry"
        ? {
            surface: "edition",
            commands: [
              `radar edition show ${binding.edition_ref}`,
              `radar feedback add --opportunity ${binding.opportunity_ref} --kind saved|used|dismissed|not_relevant|too_risky|already_seen`,
            ],
          }
        : {
            surface: "reading_list",
            commands: [
              `radar market reading list --language ${projection.context.language}`,
              ...(candidate.deterministic.market_basis === "unknown" ? ["radar market brief show"] : []),
            ],
          },
      advisory_only: true,
    };
  });
}

function compareWithBaseline(projection: ReadingProjection, admitted: ProjectionCandidate[], suggestions: ReadingSuggestion[]): BaselineComparison {
  const baselineOrder = projection.candidates.map((c) => c.binding.kind === "edition_entry" ? c.binding.opportunity_ref : c.binding.work_ref);
  const suggested = [...suggestions].sort((a, b) => {
    const rank = (s: ReadingSuggestion) => (s.relevance ? RELEVANCE_RANK[s.relevance] ?? 3 : 3);
    return rank(a) - rank(b);
  }).map((s) => s.ref);
  const retained = baselineOrder.filter((ref) => suggested.includes(ref)).length;
  return {
    kind: "deterministic_order",
    baseline_order: baselineOrder,
    suggested_order: suggested,
    retained,
    added: 0,
    note: "comparison only: the underlying ordering is never rewritten and false negatives stay reviewable in the original surface",
  };
}

function priorAttempts(db: RadarDb, baseKey: string): Array<{ payload: ReadingJudgmentRecord }> {
  return db.select().from(readingJudgments).where(like(readingJudgments.attemptKey, `${baseKey}-a%`))
    .all().map((row) => ({ payload: row.payload }));
}

function persist(db: RadarDb, record: ReadingJudgmentRecord): ReadingJudgmentRecord {
  if (!record.attempt_key) throw new JudgmentConsumerError("attempt_key_required", "A judgment record needs an attempt key before persistence.");
  db.insert(readingJudgments).values({
    attemptKey: record.attempt_key,
    requestId: record.request_id,
    attemptId: record.attempt_id,
    target: record.target.kind,
    createdAt: record.created_at,
    payload: record,
  }).onConflictDoUpdate({ target: readingJudgments.attemptKey, set: { payload: record } }).run();
  return record;
}

// Zero-network replay: reading stored evidence never constructs a transport
// and never re-submits anything to a provider.
export function showReadingJudgment(db: RadarDb, attemptKey: string): ReadingJudgmentRecord | null {
  return db.select().from(readingJudgments).where(eq(readingJudgments.attemptKey, attemptKey)).get()?.payload ?? null;
}

export function listReadingJudgmentKeys(db: RadarDb, limit = 10): string[] {
  return db.select({ key: readingJudgments.attemptKey }).from(readingJudgments).limit(limit).all().map((row) => row.key);
}

export const JUDGMENT_EVALUATE_OP = EVALUATE_OP; // op name recorded for evidence traceability
