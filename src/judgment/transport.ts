import {
  DESCRIBE_CAPABILITIES_OP,
  EVALUATE_OP,
  JUDGMENT_SCHEMA_VERSION,
  JudgmentError,
  expectedPairs,
  requestInputDigest,
  type JudgmentRequest,
  type JudgmentResult,
  type JudgmentResultItem,
} from "./contract.ts";
import type { PrimitiveKind } from "./questionset.ts";

// Injected transport seam. Production transports come from the public SDK
// package (HTTP / stdio to an authorized adapter) once it ships; until then
// the fixture transport is the only wired implementation. Transports never
// receive credentials from this repo and never auto-retry.

export interface JudgmentTransportCapabilities {
  schema_version: string;
  transport: string;
  adapter: string | null;
  adapter_version: string | null;
  models: Array<{
    transport_provider: string;
    model_provider: string;
    model: string;
    modalities: string[];
    primitives: PrimitiveKind[];
  }>;
  max_batch_candidates: number;
  max_questions: number;
  max_input_bytes: number;
  max_output_bytes: number;
  languages_note: string;
  probability_available: boolean;
  confidence_available: boolean;
  confidence_provenance: string | null;
  reconcile_supported: boolean;
  cancel_supported: boolean;
  idempotency_note: string;
}

export interface JudgmentTransport {
  readonly transport: string;
  readonly ops: readonly string[];
  describeCapabilities(): Promise<JudgmentTransportCapabilities>;
  evaluate(request: JudgmentRequest): Promise<JudgmentResult>;
}

export type FixtureScenario =
  | "answered"
  | "abstain-required"
  | "unknown-outcome"
  | "malformed-pair"
  | "unavailable";

export const FIXTURE_SCENARIOS: readonly FixtureScenario[] = [
  "answered",
  "abstain-required",
  "unknown-outcome",
  "malformed-pair",
  "unavailable",
];

export const FIXTURE_TRANSPORT_NAME = "judgment-fixture";
const FIXTURE_MODEL = {
  transport_provider: FIXTURE_TRANSPORT_NAME,
  model_provider: "fixture",
  model: "fixture-reading-judge.0",
};

export function fixtureCapabilities(): JudgmentTransportCapabilities {
  return {
    schema_version: JUDGMENT_SCHEMA_VERSION,
    transport: FIXTURE_TRANSPORT_NAME,
    adapter: null,
    adapter_version: null,
    models: [{ ...FIXTURE_MODEL, modalities: ["text"], primitives: ["choice", "ordinal_score", "binary"] }],
    max_batch_candidates: 8,
    max_questions: 3,
    max_input_bytes: 20_000,
    max_output_bytes: 64_000,
    languages_note: "fixture; no real language capability — offline contract verification only",
    probability_available: false,
    confidence_available: false,
    confidence_provenance: null,
    reconcile_supported: false,
    cancel_supported: false,
    idempotency_note: "fixture; the owner-side attempt store provides replay",
  };
}

export interface FixtureTransport extends JudgmentTransport {
  readonly calls: { describe: number; evaluate: number };
  readonly requests: JudgmentRequest[];
}

// Scriptable offline transport. It answers from the request's own declared
// domains (never inventing out-of-domain values), reports no probability and
// no confidence, and can raise each contract-relevant failure class.
export function createFixtureTransport(options: { scenario?: FixtureScenario } = {}): FixtureTransport {
  const scenario = options.scenario ?? "answered";
  const calls = { describe: 0, evaluate: 0 };
  const requests: JudgmentRequest[] = [];
  return {
    transport: FIXTURE_TRANSPORT_NAME,
    ops: [DESCRIBE_CAPABILITIES_OP, EVALUATE_OP],
    calls,
    requests,
    async describeCapabilities() {
      calls.describe += 1;
      return fixtureCapabilities();
    },
    async evaluate(request) {
      calls.evaluate += 1;
      requests.push(request);
      if (scenario === "unavailable") {
        throw new JudgmentError("unavailable", "Fixture transport is configured unavailable.", "not_submitted", "safe_before_submit", "fixture-unavailable");
      }
      if (scenario === "unknown-outcome") {
        throw new JudgmentError("outcome_unknown", "Fixture simulates a post-submission timeout; the outcome is unknown.", "unknown", "reconcile_first", "fixture-timeout");
      }
      const pairs = expectedPairs(request);
      const questions = new Map(request.questions.map((q) => [q.question_id, q]));
      const items: JudgmentResultItem[] = [];
      for (const [candidateId, questionId] of pairs) {
        if (scenario === "malformed-pair" && items.length === pairs.length - 1) continue; // drop the last expected pair
        const question = questions.get(questionId)!;
        const required = question.required;
        if (scenario === "abstain-required" && required) {
          items.push({ candidate_id: candidateId, question_id: questionId, answer_status: "abstained", value: null, reason_code: "fixture_abstained" });
          continue;
        }
        const value = question.primitive.kind === "choice" ? { option_id: question.primitive.options[1] ?? question.primitive.options[0]! }
          : question.primitive.kind === "binary" ? { binary: true }
            : { level_id: question.primitive.levels[0]!.level_id };
        items.push({ candidate_id: candidateId, question_id: questionId, answer_status: "answered", value, reason_code: "fixture_answered" });
      }
      const result: JudgmentResult = {
        schema_version: JUDGMENT_SCHEMA_VERSION,
        request_id: request.request_id,
        attempt_id: request.attempt_id,
        input_digest: requestInputDigest(request),
        resolved_model: { ...FIXTURE_MODEL },
        execution_status: scenario === "malformed-pair" ? "partial" : "succeeded",
        items,
        latency_ms: 0,
        provider_request_id: null,
      };
      return result;
    },
  };
}
