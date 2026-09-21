import { eq } from "drizzle-orm";
import type { RadarDb } from "../db/client.ts";
import { personalProfiles, readingJudgments } from "../db/schema.ts";
import { addFeedback, FEEDBACK_KINDS, type FeedbackReceipt } from "../pipeline/feedback.ts";
import { ProfileService } from "../profile/service.ts";
import { editionByRef } from "../pipeline/edition.ts";
import { marketReadPolicy } from "../market/policy.ts";
import { readTitleTranslation } from "../market/translation.ts";
import { workMapping } from "../market/identity.ts";
import { MarketStoreError } from "../market/repository.ts";
import { showReadingJudgment, type ReadingJudgmentRecord, type ReadingSuggestion } from "./consumer.ts";

// Adoption of an advisory reading suggestion reuses the original review
// services and re-verifies every binding first. A stale source revision or a
// revoked permission blocks adoption; evaluation never executes business
// mutations, and even acceptance only routes through the pre-existing
// feedback flow (edition candidates) or hands back to the original surface
// (reading-list candidates) without executing anything implicitly.

export class JudgmentAdoptionError extends Error {
  constructor(
    public readonly code:
      | "attempt_not_found"
      | "mode_not_adoptable"
      | "execution_not_adoptable"
      | "candidate_not_found"
      | "suggestion_not_adoptable"
      | "judgment_stale"
      | "permission_revoked"
      | "kind_invalid",
    message: string,
  ) {
    super(message);
    this.name = "JudgmentAdoptionError";
  }
}

export type AcceptOutcome =
  | {
      executed: true;
      surface: "edition_feedback";
      kind: string;
      receipt: FeedbackReceipt;
      review_refs: string[];
      already_accepted: boolean;
    }
  | {
      executed: false;
      surface: "reading_list" | "market_brief";
      handoff: { commands: string[] };
      reason: string;
    };

export function acceptReadingSuggestion(
  db: RadarDb,
  input: { attempt_key: string; candidate_id: string; kind: string; idempotency_key?: string; now?: Date },
): AcceptOutcome {
  const now = input.now ?? new Date();
  const record = showReadingJudgment(db, input.attempt_key);
  if (!record) throw new JudgmentAdoptionError("attempt_not_found", `No stored judgment attempt '${input.attempt_key}'.`);

  // Shadow records are comparison-only: they never adopt.
  if (record.mode === "shadow") {
    throw new JudgmentAdoptionError("mode_not_adoptable", "Shadow-mode judgments compare against the baseline only; re-evaluate with --mode assist before adopting.");
  }
  if (record.execution_status !== "succeeded" && record.execution_status !== "partial") {
    throw new JudgmentAdoptionError("execution_not_adoptable", `Attempt ended '${record.execution_status}'; only completed evaluations can be adopted.`);
  }
  const suggestion = record.suggestions.find((s) => s.candidate_id === input.candidate_id);
  if (!suggestion) throw new JudgmentAdoptionError("candidate_not_found", `Candidate '${input.candidate_id}' is not part of this attempt.`);
  if (!suggestion.adoptable) {
    throw new JudgmentAdoptionError("suggestion_not_adoptable", `Required answers are missing (${suggestion.blockers.join(", ")}); the suggestion stays advisory.`);
  }
  if (!FEEDBACK_KINDS.includes(input.kind as never)) {
    throw new JudgmentAdoptionError("kind_invalid", `kind must be one of ${FEEDBACK_KINDS.join("|")}; the human chooses the review outcome, not the model.`);
  }
  if (record.accepted) {
    throw new JudgmentAdoptionError("judgment_stale", "This suggestion was already adopted; start a new evaluation for further actions.");
  }

  const candidate = record.bindings.candidates.find((c) => c.candidate_id === input.candidate_id)!;

  // Permission and freshness re-checks run against the CURRENT state; the
  // stored judgment is only history. Nothing about the old attempt authorizes
  // acting on a changed world.
  verifyFreshAndAuthorized(db, record, candidate.topics);

  if (candidate.binding.kind === "reading_item") {
    // Reading-list adoption happens in the original surface (reading list /
    // market brief review commands); the judgment module never executes it.
    return {
      executed: false,
      surface: candidate.deterministic.market_basis === "unknown" ? "market_brief" : "reading_list",
      handoff: { commands: suggestion.handoff.commands },
      reason: "reading-list suggestions are adopted through the original reading/brief review flow; no implicit business execution",
    };
  }

  // Edition candidates adopt through the pre-existing feedback service —
  // the same permission gate `radar feedback add` uses.
  const profileRef = record.bindings.authorization.profile_ref;
  if (!profileRef) throw new JudgmentAdoptionError("permission_revoked", "The bound profile is no longer available.");
  const idempotencyKey = input.idempotency_key ?? `rj-accept-${record.attempt_key}-${input.candidate_id}`;
  const receipt = addFeedback(db, {
    profileRef,
    opportunityRef: candidate.binding.opportunity_ref,
    kind: input.kind,
    idempotencyKey,
  }, now);
  const reviewRefs = [`feedback_id=${receipt.id}`, `idempotency_key=${idempotencyKey}`, `attempt_key=${record.attempt_key}`];
  markAccepted(db, record, { kind: input.kind, review_refs: reviewRefs, accepted_at: now.toISOString() });
  return { executed: true, surface: "edition_feedback", kind: input.kind, receipt, review_refs: reviewRefs, already_accepted: receipt.duplicate };
}

function verifyFreshAndAuthorized(db: RadarDb, record: ReadingJudgmentRecord, topics: string[]): void {
  const policy = marketReadPolicy(db);
  if (policy.policy_revision !== record.bindings.authorization.market_policy_revision) {
    throw new JudgmentAdoptionError("judgment_stale", "The market read policy changed after this evaluation; re-evaluate explicitly before adopting.");
  }
  if (policy.blocked_topics.length > 0 && (!topics.length || topics.some((t) => policy.blocked_topics.includes(t)))) {
    // Generic message only: a revoked read permission must not confirm the
    // existence of the blocked content.
    throw new JudgmentAdoptionError("permission_revoked", "This candidate is not readable under the current policy.");
  }
  if (record.target.kind === "edition") {
    const edition = record.bindings.edition_digest ? editionByRef(db, record.target.edition_ref!) : null;
    if (!edition || edition.digest !== record.bindings.edition_digest) {
      throw new JudgmentAdoptionError("judgment_stale", "The bound edition changed; re-evaluate explicitly before adopting.");
    }
    const profileDigest = record.bindings.authorization.profile_digest;
    const active = db.select().from(personalProfiles).where(eq(personalProfiles.active, 1)).get();
    if ((active?.ref ?? null) !== record.bindings.authorization.profile_ref) {
      throw new JudgmentAdoptionError("judgment_stale", "The active profile changed after this evaluation; re-evaluate explicitly before adopting.");
    }
    if (profileDigest && active && new ProfileService(db).show(active.ref).digest !== profileDigest) {
      throw new JudgmentAdoptionError("judgment_stale", "The profile revision changed after this evaluation; re-evaluate explicitly before adopting.");
    }
    return;
  }
  // Reading target: every bound work must still sit at the mapped revision
  // with the same translation source digest, and stay readable.
  for (const candidate of record.bindings.candidates) {
    if (candidate.binding.kind !== "reading_item") continue;
    const mapping = workMapping(db, candidate.binding.work_ref);
    if (!mapping || mapping.mapping_revision !== candidate.binding.work_revision) {
      throw new JudgmentAdoptionError("judgment_stale", `Work ${candidate.binding.work_ref} moved to a new mapping revision; re-evaluate explicitly before adopting.`);
    }
    try {
      const current = readTitleTranslation(db, candidate.binding.work_ref, record.target.language ?? "zh-Hans");
      if (candidate.binding.translation_source_digest && current.translation?.source_digest !== candidate.binding.translation_source_digest) {
        throw new JudgmentAdoptionError("judgment_stale", `Work ${candidate.binding.work_ref} changed at its source; re-evaluate explicitly before adopting.`);
      }
    } catch (error) {
      if (error instanceof MarketStoreError && error.code === "content_blocked") {
        throw new JudgmentAdoptionError("permission_revoked", "This candidate is not readable under the current policy.");
      }
      throw error;
    }
  }
}

function markAccepted(db: RadarDb, record: ReadingJudgmentRecord, accepted: NonNullable<ReadingJudgmentRecord["accepted"]>): void {
  const updated: ReadingJudgmentRecord = { ...record, accepted };
  db.update(readingJudgments).set({ payload: updated }).where(eq(readingJudgments.attemptKey, record.attempt_key)).run();
}

// Bounded sanitized evidence view for readers: refs, digests and review
// state only — never source texts or model reasoning.
export function readingJudgmentEvidence(db: RadarDb, attemptKey: string) {
  const record = showReadingJudgment(db, attemptKey);
  if (!record) throw new JudgmentAdoptionError("attempt_not_found", `No stored judgment attempt '${attemptKey}'.`);
  return {
    spec: "radar.reading_judgment_evidence.v1" as const,
    attempt: {
      attempt_key: record.attempt_key,
      request_id: record.request_id,
      attempt_id: record.attempt_id,
      mode: record.mode,
      created_at: record.created_at,
    },
    versions: { question_set: record.question_set, policy: record.policy, model: record.model },
    bindings: {
      authorization: record.bindings.authorization,
      edition_digest: record.bindings.edition_digest ?? null,
      candidates: record.bindings.candidates.map((c) => ({
        candidate_id: c.candidate_id,
        ref: c.binding.kind === "edition_entry" ? c.binding.opportunity_ref : c.binding.work_ref,
        revision: c.binding.kind === "edition_entry" ? c.binding.edition_digest : String(c.binding.work_revision),
        deterministic: c.deterministic,
      })),
    },
    execution: {
      status: record.execution_status,
      usage: record.usage,
      latency_ms: record.latency_ms,
      provider_request_id: record.provider_request_id,
      error: record.error,
    },
    normalized_items: record.items,
    suggestions: record.suggestions.map((s) => ({ ...s, handoff: s.handoff.commands })),
    baseline: record.baseline,
    review: { accepted: record.accepted, advisory_only: true },
    limitations: record.limitations,
  };
}

export type ReadingSuggestionView = ReadingSuggestion;
