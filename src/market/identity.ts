import { and, desc, eq, inArray } from "drizzle-orm";
import type { RadarDb } from "../db/client.ts";
import { marketEvidence, marketWorkMappings } from "../db/schema.ts";
import { parseWorkMapping, type WorkMapping } from "./domain.ts";
import { marketDigest, MarketStoreError } from "./repository.ts";

// Stable per-source work subject. Signals, work mappings and cross-market
// lookups must agree on this derivation or identity would drift silently.
export function workSubjectRef(source_ref: string, source_item_id: string): string {
  return "work-" + marketDigest([source_ref, source_item_id]).slice(7, 31);
}

export function workMapping(db: RadarDb, ref: string, revision?: number): WorkMapping | null {
  return db.select().from(marketWorkMappings).where(revision === undefined
    ? eq(marketWorkMappings.ref, ref)
    : and(eq(marketWorkMappings.ref, ref), eq(marketWorkMappings.revision, revision)))
    .orderBy(desc(marketWorkMappings.revision)).limit(1).get()?.payload ?? null;
}

// Heads only: a superseded mapping is history, not a second identity.
export function listWorkMappings(db: RadarDb, status?: WorkMapping["mapping_status"]): WorkMapping[] {
  const heads = new Map<string, WorkMapping>();
  for (const row of db.select().from(marketWorkMappings).orderBy(marketWorkMappings.ref, desc(marketWorkMappings.revision)).all()) {
    if (!heads.has(row.ref)) heads.set(row.ref, row.payload);
  }
  const mappings = [...heads.values()].sort((a, b) => a.platform_work_ref.localeCompare(b.platform_work_ref));
  return status ? mappings.filter(m => m.mapping_status === status) : mappings;
}

const safeRef = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(v);

function requireStoredEvidence(tx: RadarDb, refs: string[]): void {
  const rows = tx.select({ ref: marketEvidence.ref }).from(marketEvidence)
    .where(inArray(marketEvidence.ref, refs)).all();
  if (refs.some(ref => !rows.some(row => row.ref === ref))) {
    throw new MarketStoreError("evidence_not_found", "Work mapping evidence must reference stored market evidence.");
  }
}

function writeMapping(tx: RadarDb, mapping: WorkMapping): void {
  tx.insert(marketWorkMappings).values({ ref: mapping.platform_work_ref, revision: mapping.mapping_revision,
    canonicalRef: mapping.canonical_work_ref, status: mapping.mapping_status, payload: mapping }).run();
}

export function saveWorkCandidate(db: RadarDb, input: unknown, expectedRevision: number): WorkMapping {
  const mapping = parseWorkMapping(input);
  // A matching title or arbitrary evidence refs is not sufficient identity
  // proof. Verified status is reserved for the owner review action below.
  if (mapping.mapping_status !== "candidate") throw new MarketStoreError("identity_review_required", "Verified mappings require an explicit identity review.");
  return db.transaction(tx => {
    const prior = workMapping(tx, mapping.platform_work_ref);
    if (prior && marketDigest(prior) === marketDigest(mapping)) return prior;
    if ((prior?.mapping_revision ?? 0) !== expectedRevision || mapping.mapping_revision !== expectedRevision + 1) {
      throw new MarketStoreError("state_conflict", "Work mapping revision changed; read before updating.");
    }
    if (mapping.supporting_evidence_refs.length) requireStoredEvidence(tx, mapping.supporting_evidence_refs);
    writeMapping(tx, mapping);
    return mapping;
  }, { behavior: "immediate" });
}

// Candidate refresh from observation imports. Same-content replays keep the
// current revision; an owner-verified mapping is never demoted automatically,
// because catalog metadata is weaker evidence than an explicit review.
export function refreshWorkCandidate(tx: RadarDb, subject: string, title: string, evidenceRef: string): boolean {
  const prior = workMapping(tx, subject);
  if (prior?.mapping_status === "verified") return false;
  const content = {
    platform_work_ref: subject, canonical_work_ref: null,
    original_title: title, aliases: prior?.aliases ?? [],
    mapping_status: "candidate" as const,
    supporting_evidence_refs: [...new Set([...(prior?.supporting_evidence_refs ?? []), evidenceRef])].sort(),
  };
  // Revision numbers are excluded: a replay must compare identity content,
  // not advance a version merely because the version field differs.
  if (prior && marketDigest({ ...prior, mapping_revision: 0 }) === marketDigest({ ...content, mapping_revision: 0 })) return false;
  writeMapping(tx, parseWorkMapping({ ...content, mapping_revision: (prior?.mapping_revision ?? 0) + 1 }));
  return true;
}

// Formal owner verification of a work identity. The recorded original title
// and aliases are never rewritten here; verification only adds the canonical
// ref plus evidence and creates the next immutable mapping revision.
export function reviewWorkMapping(db: RadarDb, input: {
  work: string; expected_revision: number; canonical_work_ref: string; evidence_refs: string[];
}): { mapping: WorkMapping; reused: boolean } {
  if (!input || !safeRef(input.work) || !safeRef(input.canonical_work_ref) ||
    !Number.isSafeInteger(input.expected_revision) || input.expected_revision < 1 ||
    !Array.isArray(input.evidence_refs) || input.evidence_refs.length < 1 || input.evidence_refs.length > 10 ||
    input.evidence_refs.some(ref => !safeRef(ref)) || new Set(input.evidence_refs).size !== input.evidence_refs.length) {
    throw new MarketStoreError("review_invalid", "Provide a work, its current mapping revision, a canonical ref and 1-10 distinct evidence refs.");
  }
  return db.transaction(tx => {
    requireStoredEvidence(tx, input.evidence_refs);
    const current = workMapping(tx, input.work);
    if (!current) throw new MarketStoreError("identity_not_found", "No work mapping exists for this ref; import observations first.");
    const verified = parseWorkMapping({
      platform_work_ref: current.platform_work_ref, canonical_work_ref: input.canonical_work_ref,
      original_title: current.original_title, aliases: current.aliases,
      mapping_revision: input.expected_revision + 1, mapping_status: "verified",
      supporting_evidence_refs: [...new Set([...current.supporting_evidence_refs, ...input.evidence_refs])].sort(),
    });
    // Replay of the identical review returns the stored revision instead of
    // failing on the now-advanced mapping revision.
    const existing = tx.select().from(marketWorkMappings).where(and(
      eq(marketWorkMappings.ref, verified.platform_work_ref), eq(marketWorkMappings.revision, verified.mapping_revision))).get();
    if (existing && marketDigest(existing.payload) === marketDigest(verified)) return { mapping: existing.payload, reused: true };
    if (current.mapping_revision !== input.expected_revision) {
      throw new MarketStoreError("state_conflict", "Work mapping revision changed; read the current mapping before reviewing.");
    }
    writeMapping(tx, verified);
    return { mapping: verified, reused: false };
  }, { behavior: "immediate" });
}
