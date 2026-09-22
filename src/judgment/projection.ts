import { and, desc, eq } from "drizzle-orm";
import type { RadarDb } from "../db/client.ts";
import { marketEvidence, marketObservations, marketWorkMappings } from "../db/schema.ts";
import { marketDigest, sourceByRef } from "../market/repository.ts";
import { marketReadPolicy } from "../market/policy.ts";
import { editionByRef, latestEdition, type EditionRecord } from "../pipeline/edition.ts";
import type { ProfileRecord } from "../profile/service.ts";
import { ProfileService } from "../profile/service.ts";
import { policyRef, questionSetRef } from "./questionset.ts";

// radar.reading_judgment.projection.v1 — the bounded, authorized input
// projection for advisory reading judgments. Deterministic checks (policy,
// required fields, source admission, language/market separation) run BEFORE
// any model call and stay authoritative; a model only ever sees the small
// inline texts assembled here. Nothing reorders, drops or rewrites the
// underlying edition or reading list — excluded candidates stay recorded so
// the original surface and explicit feedback flow keep them (no silent
// false-negative removal).

export const PROJECTION_SPEC = "radar.reading_judgment.projection.v1" as const;

export const PROJECTION_LIMITS = {
  max_candidates: 8,
  max_questions: 3,
  max_source_bytes: 1200,
  max_input_bytes: 20_000,
  peer_list_max: 10,
  tag_list_max: 40,
} as const;

// The public SDK enforces a request's max_input_bytes over the FULL
// canonical wire (envelope + inline text), while the projection seal bounds
// inline content to max_input_bytes. The declared wire cap adds this fixed
// envelope allowance (source digests, question prompts, candidate bindings,
// model identity — measured ~5.5k units at a full 8-candidate projection)
// so an in-budget projection is not rejected by its own limit; outliers
// still fail honestly in the sdk-http bridge preflight.
export const WIRE_ENVELOPE_HEADROOM_BYTES = 8_000;

export type ExclusionReason =
  | "blocked_topic"
  | "unclassified_against_policy"
  | "missing_title"
  | "source_not_admitted"
  | "sensitive_material";

export const EXCLUSION_REASONS: readonly ExclusionReason[] = [
  "blocked_topic",
  "unclassified_against_policy",
  "missing_title",
  "source_not_admitted",
  "sensitive_material",
];

export interface ProjectionSource {
  source_id: string;
  revision: number;
  digest: string;
  inline_text: string;
  language: string;
}

export interface DeterministicFlags {
  admitted: boolean;
  exclusion_reasons: ExclusionReason[];
  language: string;
  market: string;
  market_basis: "evidence" | "unknown";
  verifiable_market_evidence: boolean;
  degraded: boolean;
}

export interface EditionBinding {
  kind: "edition_entry";
  edition_ref: string;
  edition_digest: string;
  opportunity_ref: string;
  topic: string;
  hook_family: string;
  position: number;
}

export interface ReadingBinding {
  kind: "reading_item";
  work_ref: string;
  work_revision: number;
  source_ref: string;
  translation_status: "missing" | "stale" | "current";
  translation_source_digest: string | null;
}

export interface ProjectionCandidate {
  candidate_id: string;
  source_ids: string[];
  binding: EditionBinding | ReadingBinding;
  topics: string[];
  deterministic: DeterministicFlags;
}

export interface ReadingProjection {
  spec: typeof PROJECTION_SPEC;
  target: "edition" | "reading";
  scope: { owner: "radar"; project: "reading-judgment"; principal: string };
  authorization: {
    market_policy_revision: string;
    profile_ref: string | null;
    profile_revision: number | null;
    profile_digest: string | null;
  };
  question_set: { id: string; version: string; digest: string };
  policy: { id: string; version: string; digest: string };
  sources: ProjectionSource[];
  candidates: ProjectionCandidate[];
  context: {
    edition_ref?: string;
    edition_digest?: string;
    language?: string;
    omitted: number;
    truncated: boolean;
    limitations: string[];
  };
  input_digest: string;
}

// Same fail-closed class of patterns the translation service rejects, so
// credential-looking material never reaches a transport.
const SENSITIVE_PATTERN =
  /(?:authorization\s*:|bearer\s+\S+|(?:password|cookie|token|secret|api[_-]?key)\s*[=:]\s*\S+|-----BEGIN .*PRIVATE KEY|\bsk-[A-Za-z0-9_-]{16,})/i;

export function looksSensitive(text: string): boolean {
  return SENSITIVE_PATTERN.test(text);
}

export class JudgmentProjectionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "JudgmentProjectionError";
  }
}

// Caps named *_bytes are enforced in true UTF-8 bytes: CJK content (this
// product's core) occupies ~3 bytes per character, so counting UTF-16 code
// units under-enforced every byte cap against any adapter that measures
// bytes. Truncation never splits a multi-byte character.
function truncateUtf8(value: string, maxBytes: number): string {
  let out = value;
  while (Buffer.byteLength(out, "utf8") > maxBytes) out = out.slice(0, -1);
  return out;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function sourceOf(lines: string[], meta: { source_id: string; revision: number; language: string }): ProjectionSource {
  const inline_text = truncateUtf8(lines.filter((line) => line.length > 0).join("\n"), PROJECTION_LIMITS.max_source_bytes);
  return {
    source_id: meta.source_id,
    revision: meta.revision,
    digest: marketDigest({ source_id: meta.source_id, inline_text }),
    inline_text,
    language: meta.language,
  };
}

function authorizationOf(db: RadarDb): ReadingProjection["authorization"] {
  const policy = marketReadPolicy(db);
  try {
    const profile = new ProfileService(db).show();
    return {
      market_policy_revision: policy.policy_revision,
      profile_ref: profile.ref,
      profile_revision: profile.headRevision,
      profile_digest: profile.digest,
    };
  } catch {
    return { market_policy_revision: policy.policy_revision, profile_ref: null, profile_revision: null, profile_digest: null };
  }
}

// Market facts come only from stored observations bound to the candidate's
// evidence. Language never implies a market: without observation evidence the
// binding stays "unknown".
function readingCandidateFacts(
  db: RadarDb,
  workRef: string,
): { market: string; market_basis: "evidence" | "unknown"; topics: string[] } {
  const mapping = db.select().from(marketWorkMappings).where(eq(marketWorkMappings.ref, workRef))
    .orderBy(desc(marketWorkMappings.revision)).limit(1).get()?.payload;
  if (!mapping?.supporting_evidence_refs.length) return { market: "unknown", market_basis: "unknown", topics: [] };
  const evidence = db.select().from(marketEvidence).where(eq(marketEvidence.ref, mapping.supporting_evidence_refs[0]!)).get();
  if (!evidence) return { market: "unknown", market_basis: "unknown", topics: [] };
  const observations = db.select().from(marketObservations).where(and(
    eq(marketObservations.sourceRef, evidence.sourceRef),
    eq(marketObservations.itemId, evidence.payload.source_item_id ?? ""),
  )).all();
  const withMarket = observations.find((o) => o.market && o.market !== "unknown");
  return {
    market: withMarket?.market ?? "unknown",
    market_basis: withMarket ? "evidence" : "unknown",
    topics: [...new Set(observations.flatMap((o) => o.payload.topics ?? []))],
  };
}

function blocked(db: RadarDb, topics: string[]): string[] {
  return marketReadPolicy(db).blocked_topics.filter((t) => topics.includes(t));
}

function seal(target: "edition" | "reading", scope: ReadingProjection["scope"], authorization: ReadingProjection["authorization"],
  sources: ProjectionSource[], candidates: ProjectionCandidate[], context: ReadingProjection["context"]): ReadingProjection {
  // Enforce the total input byte cap by dropping tail candidates and their
  // private sources deterministically; the original surfaces keep every item.
  const isPrivate = (id: string) => id.startsWith("cand-") || id.startsWith("peers-");
  let kept = candidates.length;
  let truncated = false;
  const totalBytes = () => {
    const live = new Set(candidates.slice(0, kept).flatMap((c) => c.source_ids));
    return sources.filter((s) => live.has(s.source_id) || !isPrivate(s.source_id)).reduce((sum, s) => sum + utf8Bytes(s.inline_text), 0);
  };
  while (kept > 0 && totalBytes() > PROJECTION_LIMITS.max_input_bytes) {
    kept -= 1;
    truncated = true;
  }
  const liveIds = new Set([...candidates.slice(0, kept).flatMap((c) => c.source_ids)]);
  const liveSources = sources.filter((s) => liveIds.has(s.source_id) || !isPrivate(s.source_id));
  const limitations = [...context.limitations];
  if (truncated) limitations.push(`input byte cap reached; only the first ${kept} candidate(s) were projected (the original list is unchanged)`);
  const body = {
    spec: PROJECTION_SPEC,
    target,
    scope,
    authorization,
    question_set: questionSetRef(),
    policy: policyRef(),
    sources: liveSources,
    candidates: candidates.slice(0, kept),
    context: { ...context, truncated, limitations },
  };
  return { ...body, input_digest: marketDigest(body) };
}

export function projectEditionForJudgment(db: RadarDb, profile: ProfileRecord, editionRef?: string): ReadingProjection {
  const edition: EditionRecord | null = editionRef && editionRef !== "latest"
    ? editionByRef(db, editionRef)
    : latestEdition(db, profile.ref);
  if (!edition) throw new JudgmentProjectionError("edition_not_found", "No edition exists for this profile; run 'radar edition build' first.");
  const authorization = authorizationOf(db);
  const policy = marketReadPolicy(db);
  const blockedSet = new Set([...profile.profile.blocked_topics, ...policy.blocked_topics]);
  const languageTag = profile.profile.languages[0]?.tag ?? "unknown";
  const sources: ProjectionSource[] = [];
  const candidates: ProjectionCandidate[] = [];

  // Shared, explicitly authorized profile projection: tag labels only — no
  // profile name, no free text, no asset inventory.
  const tags = (entries: ReadonlyArray<{ tag: string }>) => entries.slice(0, PROJECTION_LIMITS.tag_list_max).map((t) => t.tag);
  sources.push(sourceOf([
    "watch-concerns (owner-authorized profile tags; advisory context only)",
    `topics: ${tags(profile.profile.topics).join(", ") || "(none)"}`,
    `hooks: ${tags(profile.profile.hooks).join(", ") || "(none)"}`,
    `languages: ${tags(profile.profile.languages).join(", ") || "(none)"}`,
    "note: language labels describe content language, never an audience market",
  ], { source_id: "watch-concerns", revision: profile.headRevision, language: languageTag }));
  sources.push(sourceOf([
    `edition-manifest ${edition.editionRef} (date=${edition.date}, status=${edition.status})`,
    ...edition.entries.map((e, i) => `${i + 1}. ${e.opportunityRef} | topic=${e.topic} | hook=${e.hookFamily}`),
  ], { source_id: "edition-manifest", revision: 1, language: "en" }));

  const entries = edition.entries.slice(0, PROJECTION_LIMITS.max_candidates);
  entries.forEach((entry, index) => {
    const reasons: ExclusionReason[] = [];
    const topics = [entry.topic];
    if (blockedSet.size > 0 && topics.some((t) => blockedSet.has(t))) reasons.push("blocked_topic");
    const lines = [
      `candidate ${index + 1}: morning-edition entry`,
      `topic: ${entry.topic}`,
      `hook_family: ${entry.hookFamily}`,
      `reason_codes: ${entry.reasonCodes.join(", ") || "(none)"}`,
      `degraded_evidence: ${entry.degraded ? "true" : "false"}`,
      `language_label: ${languageTag} (content language only)`,
      "market_label: unknown (edition entries carry no market binding; basis: unknown)",
    ];
    if (looksSensitive(lines.join("\n"))) reasons.push("sensitive_material");
    const candidateId = `cand-${index + 1}`;
    const admitted = reasons.length === 0 && entry.topic.trim().length > 0;
    if (admitted) {
      sources.push(sourceOf(lines, { source_id: candidateId, revision: 1, language: languageTag }));
      const peers = entries
        .filter((other) => other.opportunityRef !== entry.opportunityRef)
        .slice(0, PROJECTION_LIMITS.peer_list_max)
        .map((other, i) => `${i + 1}. topic=${other.topic} | hook=${other.hookFamily} | ${other.opportunityRef}`);
      sources.push(sourceOf([
        "peer-list (other entries in the same edition; for duplicate detection only)",
        ...peers,
      ], { source_id: `peers-${index + 1}`, revision: 1, language: "en" }));
    }
    candidates.push({
      candidate_id: candidateId,
      source_ids: admitted ? [candidateId, `peers-${index + 1}`, "watch-concerns", "edition-manifest"] : [],
      binding: {
        kind: "edition_entry",
        edition_ref: edition.editionRef,
        edition_digest: edition.digest,
        opportunity_ref: entry.opportunityRef,
        topic: entry.topic,
        hook_family: entry.hookFamily,
        position: entry.position,
      },
      topics,
      deterministic: {
        admitted,
        exclusion_reasons: reasons,
        language: languageTag,
        market: "unknown",
        market_basis: "unknown",
        verifiable_market_evidence: false,
        degraded: entry.degraded,
      },
    });
  });

  const omitted = edition.entries.length - candidates.filter((c) => c.deterministic.admitted).length;
  const limitations = ["advisory projection only; the edition and its ordering are never modified"];
  if (edition.status !== "ready") limitations.push(`edition status is ${edition.status}`);
  if (edition.entries.length > PROJECTION_LIMITS.max_candidates) {
    limitations.push(`edition has ${edition.entries.length} entries; projection is bounded to ${PROJECTION_LIMITS.max_candidates}`);
  }
  return seal("edition", { owner: "radar", project: "reading-judgment", principal: profile.ref },
    authorization, sources, candidates,
    { edition_ref: edition.editionRef, edition_digest: edition.digest, omitted, truncated: false, limitations });
}

export interface ReadingProjectionItem {
  work_ref: string;
  work_revision: number;
  original_title: string;
  source_ref: string;
  source_locale: string;
  status: "missing" | "stale" | "current";
  display_title: string;
  translation: { source_digest: string } | null;
}

// listChineseReading's inferred return widens the status literal; narrow it
// for the projection input without touching the stable reading-list output.
export function toReadingProjectionItems(list: {
  items: Array<{
    work_ref: string; work_revision: number; original_title: string; source_ref: string;
    source_locale: string; status: string; display_title: string;
    translation: { source_digest: string } | null;
  }>;
}): ReadingProjectionItem[] {
  return list.items.map((item) => ({ ...item, status: item.status as ReadingProjectionItem["status"] }));
}

export function projectReadingForJudgment(
  db: RadarDb,
  language: "zh-Hans" | "zh-Hant",
  list: ReadingProjectionItem[],
  omitted: number,
): ReadingProjection {
  const authorization = authorizationOf(db);
  const policy = marketReadPolicy(db);
  const sources: ProjectionSource[] = [];
  const candidates: ProjectionCandidate[] = [];

  const capped = list.slice(0, PROJECTION_LIMITS.max_candidates);
  const prepared = capped.map((item, index) => {
    const facts = readingCandidateFacts(db, item.work_ref);
    const reasons: ExclusionReason[] = [];
    if (!item.original_title.trim()) reasons.push("missing_title");
    if (!sourceByRef(db, item.source_ref)) reasons.push("source_not_admitted");
    const hits = blocked(db, facts.topics);
    if (hits.length > 0) reasons.push("blocked_topic");
    else if (policy.blocked_topics.length > 0 && facts.topics.length === 0) reasons.push("unclassified_against_policy");
    const lines = [
      `candidate ${index + 1}: chinese-reading-list item`,
      `title: ${item.original_title.slice(0, 80)}`,
      item.display_title !== item.original_title ? `display_title: ${item.display_title.slice(0, 80)}` : "",
      `translation_status: ${item.status}`,
      `language_label: ${item.source_locale} (content language only)`,
      `market_label: ${facts.market} (basis: ${facts.market_basis})`,
      facts.topics.length ? `topics: ${facts.topics.slice(0, 8).join(", ")}` : "",
    ].filter((line) => line.length > 0);
    if (looksSensitive(lines.join("\n"))) reasons.push("sensitive_material");
    return { item, facts, reasons, lines, index };
  });
  const admittedWorks = new Set(prepared.filter((p) => p.reasons.length === 0).map((p) => p.item.work_ref));

  for (const entry of prepared) {
    const candidateId = `cand-${entry.index + 1}`;
    const admitted = entry.reasons.length === 0;
    if (admitted) {
      sources.push(sourceOf(entry.lines, { source_id: candidateId, revision: entry.item.work_revision, language: entry.item.source_locale }));
      const peers = prepared
        .filter((p) => p.item.work_ref !== entry.item.work_ref && admittedWorks.has(p.item.work_ref))
        .slice(0, PROJECTION_LIMITS.peer_list_max)
        .map((p, i) => `${i + 1}. ${p.item.original_title.slice(0, 80)} | ${p.item.work_ref}`);
      sources.push(sourceOf([
        `peer-list (other current reading-list items, language=${language}; for duplicate detection only)`,
        ...peers,
      ], { source_id: `peers-${entry.index + 1}`, revision: 1, language }));
    }
    candidates.push({
      candidate_id: candidateId,
      source_ids: admitted ? [candidateId, `peers-${entry.index + 1}`] : [],
      binding: {
        kind: "reading_item",
        work_ref: entry.item.work_ref,
        work_revision: entry.item.work_revision,
        source_ref: entry.item.source_ref,
        translation_status: entry.item.status,
        translation_source_digest: entry.item.translation?.source_digest ?? null,
      },
      topics: entry.facts.topics,
      deterministic: {
        admitted,
        exclusion_reasons: entry.reasons,
        language: entry.item.source_locale,
        market: entry.facts.market,
        market_basis: entry.facts.market_basis,
        verifiable_market_evidence: entry.facts.market_basis === "evidence",
        degraded: entry.item.status === "stale",
      },
    });
  }

  const limitations = [
    "advisory projection only; the reading list, translations and reader state are never modified",
    "translations are unreviewed reading aids, never official titles or independent evidence",
  ];
  if (list.length > PROJECTION_LIMITS.max_candidates) {
    limitations.push(`reading list has ${list.length} readable items; projection is bounded to ${PROJECTION_LIMITS.max_candidates}`);
  }
  return seal("reading", { owner: "radar", project: "reading-judgment", principal: "local" },
    authorization, sources, candidates,
    { language, omitted, truncated: false, limitations });
}
