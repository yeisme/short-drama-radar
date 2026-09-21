import { marketDigest } from "../market/repository.ts";

// radar.reading_judgment.question_set.v1 — the owner-maintained atomic
// question set for advisory reading judgments over the Morning Edition and
// the Chinese reading list. Every question is atomic with an explicit answer
// domain; answers bind to (candidate_id, question_id) pairs, never to array
// positions. The set and policy are versioned and digested; changing either
// mint a new version so stored evidence can never silently change meaning.

export const QUESTION_SET_ID = "radar.reading_judgment.question_set.v1";
export const QUESTION_SET_VERSION = "1";

export const JUDGMENT_POLICY_ID = "radar.reading_judgment.policy.v1";
export const JUDGMENT_POLICY_VERSION = "1";

export type QuestionId = "morning_relevance" | "reading_duplicate" | "needs_verification";
export type PrimitiveKind = "choice" | "ordinal_score" | "binary";

export interface ChoicePrimitive {
  kind: "choice";
  options: string[]; // stable option ids
}
export interface OrdinalPrimitive {
  kind: "ordinal_score";
  levels: Array<{ level_id: string; numeric_value: number }>;
}
export interface BinaryPrimitive {
  kind: "binary";
}
export type QuestionPrimitive = ChoicePrimitive | OrdinalPrimitive | BinaryPrimitive;

export interface ReadingQuestion {
  question_id: QuestionId;
  question_text: string; // controlled English question text on the wire
  primitive: QuestionPrimitive;
  applies_to: "each_candidate";
  required: boolean;
}

export const READING_QUESTIONS: readonly ReadingQuestion[] = [
  {
    question_id: "morning_relevance",
    question_text:
      "Given the reader's selected watch concerns listed in the watch-concerns source, is this candidate relevant for today's reading list?",
    primitive: { kind: "choice", options: ["relevant", "partially_relevant", "not_relevant"] },
    applies_to: "each_candidate",
    required: true,
  },
  {
    question_id: "reading_duplicate",
    question_text:
      "Does this candidate duplicate another item listed in its peer-list source (the same story or the same underlying work)?",
    primitive: { kind: "binary" },
    applies_to: "each_candidate",
    required: false,
  },
  {
    question_id: "needs_verification",
    question_text:
      "Apart from the deterministic flags the owner already recorded, does this candidate lack verifiable market evidence such as source admission, a market binding, or corroboration?",
    primitive: { kind: "binary" },
    applies_to: "each_candidate",
    required: true,
  },
] as const;

// Advisory policy v1: adoption requires every required question to be
// answered; thresholds are calibrated per task and per language with no
// global numeric default (null means "not calibrated yet" — suggestions stay
// exploratory). A model confidence may never override evidence confidence.
export interface ReadingJudgmentPolicyRules {
  required_question_ids: QuestionId[];
  adoption_requires_all_required_answered: boolean;
  distribution_sum_tolerance: number; // local precision policy for wire distributions
  per_language_thresholds: ReadonlyArray<{ language: string; threshold: number | null; note: string }>;
  suggestions_are_advisory_only: boolean;
  judgment_confidence_may_override_evidence_confidence: false;
}

export const READING_JUDGMENT_POLICY: ReadingJudgmentPolicyRules = {
  required_question_ids: ["morning_relevance", "needs_verification"],
  adoption_requires_all_required_answered: true,
  distribution_sum_tolerance: 0.02,
  per_language_thresholds: [
    { language: "zh-Hans", threshold: null, note: "not calibrated yet; see docs/product/reading-judgment.md" },
    { language: "zh-Hant", threshold: null, note: "not calibrated yet; see docs/product/reading-judgment.md" },
    { language: "en", threshold: null, note: "not calibrated yet; see docs/product/reading-judgment.md" },
  ],
  suggestions_are_advisory_only: true,
  judgment_confidence_may_override_evidence_confidence: false,
} as const;

export function questionSetDigest(): string {
  return marketDigest({ id: QUESTION_SET_ID, version: QUESTION_SET_VERSION, questions: READING_QUESTIONS });
}

export function questionSetRef(): { id: string; version: string; digest: string } {
  return { id: QUESTION_SET_ID, version: QUESTION_SET_VERSION, digest: questionSetDigest() };
}

export function policyDigest(): string {
  return marketDigest({ id: JUDGMENT_POLICY_ID, version: JUDGMENT_POLICY_VERSION, rules: READING_JUDGMENT_POLICY });
}

export function policyRef(): { id: string; version: string; digest: string } {
  return { id: JUDGMENT_POLICY_ID, version: JUDGMENT_POLICY_VERSION, digest: policyDigest() };
}
