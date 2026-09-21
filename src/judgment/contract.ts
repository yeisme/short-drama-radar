import { marketDigest } from "../market/repository.ts";
import type { QuestionPrimitive } from "./questionset.ts";

// Frozen wire contract of the public structured-judgment SDK
// (aigora-structured-judgment-sdk-v1): snake_case UTF-8 JSON,
// schema_version "1.0", ops DescribeCapabilities / Evaluate, primitives
// choice / ordinal_score / binary, and the stable error code set with
// submission_state + retry_class. Radar consumes this shape through an
// injected transport; the SDK package may replace the fixture transport
// later without touching domain code. Nothing here reads credentials,
// environment or network.

export const JUDGMENT_SCHEMA_VERSION = "1.0" as const;
export const DESCRIBE_CAPABILITIES_OP = "DescribeCapabilities" as const;
export const EVALUATE_OP = "Evaluate" as const;

export type JudgmentExecutionStatus = "succeeded" | "partial" | "failed" | "unknown";
export type AnswerStatus = "answered" | "abstained" | "error";
export type JudgmentErrorCode =
  | "unsupported_capability"
  | "invalid_request"
  | "unauthorized"
  | "rate_limited"
  | "unavailable"
  | "deadline_exceeded"
  | "invalid_response"
  | "outcome_unknown";
export type SubmissionState = "not_submitted" | "submitted" | "unknown";
export type RetryClass = "safe_before_submit" | "reconcile_first" | "never";

export class JudgmentError extends Error {
  constructor(
    public readonly code: JudgmentErrorCode,
    message: string,
    public readonly submission_state: SubmissionState,
    public readonly retry_class: RetryClass,
    public readonly diagnostic_ref: string,
  ) {
    super(message);
    this.name = "JudgmentError";
  }
}

export interface JudgmentRequestSource {
  source_id: string;
  revision: number;
  digest: string;
  inline_text: string;
  language: string;
}

export interface JudgmentRequestCandidate {
  candidate_id: string;
  source_ids: string[]; // exact source bindings; content is untrusted
}

export interface JudgmentRequestQuestion {
  question_id: string;
  primitive: QuestionPrimitive;
  question_text: string;
  candidate_ids: string[]; // explicit pair binding, never array order
  required: boolean;
}

export interface JudgmentLimits {
  deadline_ms: number;
  max_candidates: number;
  max_questions: number;
  max_input_bytes: number;
  max_output_bytes: number;
}

export interface JudgmentRequest {
  schema_version: typeof JUDGMENT_SCHEMA_VERSION;
  request_id: string;
  attempt_id: string;
  scope: { owner: string; project: string; principal: string };
  model: { transport_provider: string; model_provider: string; requested_model: string };
  question_set: { id: string; version: string; digest: string };
  policy_ref: { id: string; version: string; digest: string };
  sources: JudgmentRequestSource[];
  candidates: JudgmentRequestCandidate[];
  questions: JudgmentRequestQuestion[];
  limits: JudgmentLimits;
  extensions?: Record<string, unknown>;
}

export type JudgmentAnswerValue =
  | { option_id: string }
  | { level_id: string }
  | { binary: boolean };

export interface JudgmentResultItem {
  candidate_id: string;
  question_id: string;
  answer_status: AnswerStatus;
  value: JudgmentAnswerValue | null;
  distribution?: Record<string, number> | null;
  confidence?: { value: number; provenance: string } | null;
  probability_true?: number | null;
  reason_code?: string | null;
  source_refs?: string[];
}

export interface JudgmentResult {
  schema_version: string;
  request_id: string;
  attempt_id: string;
  input_digest: string;
  resolved_model: { transport_provider: string; model_provider: string; model: string };
  execution_status: JudgmentExecutionStatus;
  items: JudgmentResultItem[];
  usage?: unknown;
  latency_ms?: number | null;
  provider_request_id?: string | null;
}

// Canonical digest over the normalized wire input (everything semantic,
// excluding the envelope ids request_id/attempt_id).
export function requestInputDigest(request: JudgmentRequest): string {
  const { schema_version, scope, model, question_set, policy_ref, sources, candidates, questions, limits, extensions } = request;
  return marketDigest({ schema_version, scope, model, question_set, policy_ref, sources, candidates, questions, limits, extensions: extensions ?? null });
}

export function expectedPairs(request: JudgmentRequest): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const question of request.questions) {
    for (const candidateId of question.candidate_ids) pairs.push([candidateId, question.question_id]);
  }
  return pairs.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
}

export function validateJudgmentRequest(request: JudgmentRequest): string[] {
  const problems: string[] = [];
  if (request.schema_version !== JUDGMENT_SCHEMA_VERSION) problems.push("schema_version must be '1.0'");
  if (!request.request_id || !request.attempt_id) problems.push("request_id and attempt_id are required");
  const sourceIds = new Set(request.sources.map((s) => s.source_id));
  if (sourceIds.size !== request.sources.length) problems.push("source_id values must be unique");
  const candidateIds = new Set(request.candidates.map((c) => c.candidate_id));
  if (candidateIds.size !== request.candidates.length) problems.push("candidate_id values must be unique");
  const questionIds = new Set(request.questions.map((q) => q.question_id));
  if (questionIds.size !== request.questions.length) problems.push("question_id values must be unique");
  for (const candidate of request.candidates) {
    if (candidate.source_ids.some((id) => !sourceIds.has(id))) problems.push(`candidate ${candidate.candidate_id} binds unknown sources`);
  }
  for (const question of request.questions) {
    if (new Set(question.candidate_ids).size !== question.candidate_ids.length) problems.push(`question ${question.question_id} repeats a candidate binding`);
    if (question.candidate_ids.some((id) => !candidateIds.has(id))) problems.push(`question ${question.question_id} binds unknown candidates`);
    if (!primitiveProblems(question.primitive).every(Boolean)) problems.push(`question ${question.question_id} has an invalid primitive`);
    if (typeof question.question_text !== "string" || !question.question_text.trim()) problems.push(`question ${question.question_id} needs controlled text`);
  }
  const limits = request.limits;
  for (const [key, value] of Object.entries(limits)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) problems.push(`limits.${key} must be a positive finite number`);
  }
  if (request.sources.reduce((sum, s) => sum + s.inline_text.length, 0) > limits.max_input_bytes) problems.push("inline sources exceed max_input_bytes");
  return problems;
}

function primitiveProblems(primitive: QuestionPrimitive): boolean[] {
  switch (primitive.kind) {
    case "choice":
      return [primitive.options.length > 0, new Set(primitive.options).size === primitive.options.length];
    case "ordinal_score":
      return [primitive.levels.length > 0, new Set(primitive.levels.map((l) => l.level_id)).size === primitive.levels.length];
    case "binary":
      return [true];
  }
}

export interface ResultValidation {
  valid: boolean;
  problems: string[];
  byPair: Map<string, JudgmentResultItem>;
}

// Structure first, domain thresholds second — the order cannot be reversed.
export function validateJudgmentResult(
  request: JudgmentRequest,
  result: JudgmentResult,
  distributionTolerance: number,
): ResultValidation {
  const problems: string[] = [];
  const byPair = new Map<string, JudgmentResultItem>();
  if (result.schema_version !== JUDGMENT_SCHEMA_VERSION) problems.push("result schema_version must be '1.0'");
  if (result.request_id !== request.request_id || result.attempt_id !== request.attempt_id) {
    problems.push("result ids must match the request");
  }
  if (result.input_digest !== requestInputDigest(request)) problems.push("result input_digest does not bind this request input");
  if (!result.resolved_model?.model) problems.push("resolved_model must carry the exact executed model");
  if (!["succeeded", "partial", "failed", "unknown"].includes(result.execution_status)) problems.push("execution_status is out of the enum");

  const questions = new Map(request.questions.map((q) => [q.question_id, q]));
  const expected = expectedPairs(request);
  const seen = new Set<string>();
  const key = (candidateId: string, questionId: string) => `${candidateId} ${questionId}`;
  for (const item of result.items ?? []) {
    const pairKey = key(item.candidate_id, item.question_id);
    if (!expected.some(([c, q]) => key(c, q) === pairKey)) {
      problems.push(`unexpected pair ${item.candidate_id}/${item.question_id}`);
      continue;
    }
    if (seen.has(pairKey)) {
      problems.push(`duplicate pair ${item.candidate_id}/${item.question_id}`);
      continue;
    }
    seen.add(pairKey);
    byPair.set(pairKey, item);
    const question = questions.get(item.question_id)!;
    if (!["answered", "abstained", "error"].includes(item.answer_status)) problems.push(`${pairKey}: answer_status is out of the enum`);
    if (item.answer_status === "answered") {
      if (!item.value) problems.push(`${pairKey}: answered items must carry a value`);
      else problems.push(...valueProblems(question.primitive, item.value).map((p) => `${pairKey}: ${p}`));
    } else if (item.value !== null && item.value !== undefined) {
      problems.push(`${pairKey}: abstained or errored items must not carry an adoptable value`);
    }
    if (item.distribution != null) problems.push(...distributionProblems(question.primitive, item.distribution, distributionTolerance).map((p) => `${pairKey}: ${p}`));
    if (item.confidence != null) {
      const ok = typeof item.confidence.value === "number" && item.confidence.value >= 0 && item.confidence.value <= 1
        && typeof item.confidence.provenance === "string" && item.confidence.provenance.length > 0;
      if (!ok) problems.push(`${pairKey}: confidence must be null or {value in [0,1], provenance}`);
    }
    if (item.probability_true != null) {
      if (question.primitive.kind !== "binary") problems.push(`${pairKey}: probability_true only exists for binary questions`);
      if (typeof item.probability_true !== "number" || item.probability_true < 0 || item.probability_true > 1) problems.push(`${pairKey}: probability_true must be in [0,1]`);
    }
    if (item.reason_code != null && (typeof item.reason_code !== "string" || item.reason_code.length > 64 || !/^[a-z0-9_.-]+$/.test(item.reason_code))) {
      problems.push(`${pairKey}: reason_code must be a bounded enum-like token`);
    }
  }
  for (const [candidateId, questionId] of expected) {
    if (!seen.has(key(candidateId, questionId))) problems.push(`missing pair ${candidateId}/${questionId}`);
  }
  return { valid: problems.length === 0, problems, byPair };
}

function valueProblems(primitive: QuestionPrimitive, value: JudgmentAnswerValue): string[] {
  if (primitive.kind === "choice") {
    return "option_id" in value && primitive.options.includes(value.option_id) ? [] : ["choice value must be a declared option_id"];
  }
  if (primitive.kind === "ordinal_score") {
    return "level_id" in value && primitive.levels.some((l) => l.level_id === value.level_id) ? [] : ["ordinal value must be a declared level_id"];
  }
  return "binary" in value && typeof value.binary === "boolean" ? [] : ["binary value must be a boolean"];
}

function distributionProblems(primitive: QuestionPrimitive, distribution: Record<string, number>, tolerance: number): string[] {
  const domain = primitive.kind === "choice" ? primitive.options
    : primitive.kind === "ordinal_score" ? primitive.levels.map((l) => l.level_id)
      : ["true", "false"];
  const problems: string[] = [];
  const keys = Object.keys(distribution);
  if (keys.some((k) => !domain.includes(k))) problems.push("distribution keys must match the answer domain");
  const values = Object.values(distribution);
  if (values.some((v) => typeof v !== "number" || !Number.isFinite(v) || v < 0)) problems.push("distribution values must be finite and non-negative");
  const sum = values.reduce((s, v) => s + v, 0);
  if (Number.isFinite(sum) && Math.abs(sum - 1) > tolerance) problems.push(`distribution must sum to 1 within ${tolerance}`);
  return problems;
}

// Transport failures map onto the stable error set with the submission state
// deciding whether a retry could double-bill. The SDK never retries by
// itself; neither does this consumer.
export function classifySubmissionFailure(error: unknown): JudgmentError {
  if (error instanceof JudgmentError) return error;
  const message = error instanceof Error ? error.message : String(error);
  // A failure observed only after submit (timeout, dropped connection) says
  // nothing about whether the provider executed — or billed — the request.
  if (/timeout|aborted|ECONNRESET|EPIPE|socket hang up/i.test(message)) {
    return new JudgmentError("outcome_unknown", "The attempt state is unknown after submission; do not auto-resend.", "unknown", "reconcile_first", "transport-disconnect");
  }
  return new JudgmentError("unavailable", "The judgment transport is unavailable; the original flow is unaffected.", "not_submitted", "safe_before_submit", "transport-failure");
}
