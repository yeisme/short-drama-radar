import { createHash } from "node:crypto";
import { and, desc, eq, like } from "drizzle-orm";
import type { RadarDb } from "../db/client.ts";
import { morningEditions, morningEditionEntries, runs } from "../db/schema.ts";
import type { PersonalProfileV1 } from "../profile/domain.ts";
import type { ProfileRecord } from "../profile/service.ts";
import { BUILDER_VERSION, loadOpportunities, opportunityByRef } from "./opportunity.ts";
import { RANKER_VERSION, rankOpportunities } from "./ranker.ts";
import { suppressedDigests } from "./feedback.ts";

// radar.morning_edition.v1 — immutable personal edition bound to profile
// revision + ranker version + evidence digest. High-precision empty is a
// valid outcome; nothing low-quality is ever added to fill the list.

export const EDITION_SPEC = "radar.morning_edition.v1" as const;
export const DEFAULT_LIMIT = 8;

export interface EditionEntry {
  position: number;
  opportunityRef: string;
  topic: string;
  hookFamily: string;
  marketScore: number;
  personalFit: number;
  evidenceConfidence: number;
  reasonCodes: string[];
  sourceRefs: string[];
  degraded: boolean;
}

export interface EditionRecord {
  spec: typeof EDITION_SPEC;
  editionRef: string;
  profileRef: string;
  profileRevision: number;
  date: string;
  generatedAt: string;
  builderVersion: string;
  rankerVersion: string;
  sourceRunRefs: string[];
  evidenceDigest: string;
  status: "ready" | "empty" | "degraded";
  limitations: string[];
  digest: string; // immutable content digest of this edition
  entries: EditionEntry[];
}

export interface BuildEditionOutcome {
  edition: EditionRecord;
  excluded: { belowThreshold: number; blocked: number; suppressed: number; noData: boolean };
  // True when an identical build already existed and was returned as-is
  // (idempotent rebuild — no new edition row).
  reused: boolean;
}

export function buildEdition(
  db: RadarDb,
  profile: ProfileRecord,
  date: string,
  limit = DEFAULT_LIMIT,
  now = new Date(),
): BuildEditionOutcome {
  const opps = loadOpportunities(db, date);
  const ranked = rankOpportunities(db, profile.profile, profile.ref, opps);

  // Admission thresholds from the profile (defaults 65/60).
  const minFit = profile.profile.minimum_fit;
  const minConf = profile.profile.minimum_confidence;

  // Exclusion counts for the honest-empty explanation.
  const blockedCount = opps.filter((o) => profile.profile.blocked_topics.includes(o.topic)).length;
  const suppressed = suppressedDigests(db, profile.ref);
  const suppressedCount = opps.filter((o) => suppressed.has(o.evidenceDigest)).length;
  const belowThreshold = ranked.filter((r) => r.personalFit < minFit || r.opportunity.evidenceConfidence < minConf).length;

  const admitted = ranked.filter((r) => r.personalFit >= minFit && r.opportunity.evidenceConfidence >= minConf).slice(0, limit);

  const dataDegraded = opps.some((o) => o.degraded);
  const status: EditionRecord["status"] = admitted.length === 0 ? "empty" : dataDegraded ? "degraded" : "ready";
  const limitations: string[] = [];
  if (admitted.length === 0) {
    if (opps.length === 0) limitations.push("no scored opportunities for this date; run 'radar collect' and 'radar score' first");
    else if (belowThreshold > 0) limitations.push(`${belowThreshold} candidates below admission thresholds (min_fit=${minFit}, min_confidence=${minConf})`);
    if (blockedCount > 0) limitations.push(`${blockedCount} candidates hard-filtered by blocked topics`);
    if (suppressedCount > 0) limitations.push(`${suppressedCount} candidates suppressed as already_seen`);
  }
  if (dataDegraded && admitted.length > 0) limitations.push("some evidence collected in degraded mode; treat metrics as lower bounds");

  const generatedAt = now.toISOString();
  const entries: EditionEntry[] = admitted.map((r, i) => ({
    position: i + 1,
    opportunityRef: r.opportunity.ref,
    topic: r.opportunity.topic,
    hookFamily: r.opportunity.hookFamily,
    marketScore: r.opportunity.marketScore,
    personalFit: r.personalFit,
    evidenceConfidence: r.opportunity.evidenceConfidence,
    reasonCodes: r.reasonCodes,
    sourceRefs: r.opportunity.sourceRefs,
    degraded: r.opportunity.degraded,
  }));

  // Deterministic lineage: the day's most recent runs by start time, not an
  // unordered slice of whatever SQLite returned last.
  const sourceRunRefs = db.select().from(runs)
    .where(like(runs.startedAt, `${date}%`))
    .orderBy(desc(runs.startedAt))
    .limit(5)
    .all()
    .map((r) => r.id);
  const evidenceDigest = `sha256:${createHash("sha256").update(opps.map((o) => o.evidenceDigest).sort().join(",")).digest("hex").slice(0, 16)}`;
  // Input fingerprint over everything that determines the admission outcome:
  // the ranked input tuples (feedback adjustments live in personalFit, so
  // new feedback changes the fingerprint without a profile revision bump)
  // and the limit. Identical inputs => identical editionRef => the existing
  // immutable edition is returned as-is. The ref used to hash generatedAt,
  // which made every rebuild a fresh row.
  const fingerprint = createHash("sha256").update(JSON.stringify({
    ranked: ranked.map((r) => [r.opportunity.ref, r.opportunity.marketScore, r.opportunity.evidenceConfidence, r.opportunity.degraded, r.personalFit]),
    limit,
  })).digest("hex").slice(0, 12);
  const editionRef = `edition-${date}-${createHash("sha256").update(`${profile.ref}|${profile.headRevision}|${fingerprint}`).digest("hex").slice(0, 8)}`;
  const existing = db.select().from(morningEditions).where(eq(morningEditions.editionRef, editionRef)).all()[0];
  if (existing) {
    return { edition: hydrate(db, existing), excluded: { belowThreshold, blocked: blockedCount, suppressed: suppressedCount, noData: opps.length === 0 }, reused: true };
  }
  const digest = `sha256:${createHash("sha256").update(JSON.stringify({ editionRef, entries, status, evidenceDigest })).digest("hex").slice(0, 16)}`;

  const edition: EditionRecord = {
    spec: EDITION_SPEC,
    editionRef,
    profileRef: profile.ref,
    profileRevision: profile.headRevision,
    date,
    generatedAt,
    builderVersion: BUILDER_VERSION,
    rankerVersion: RANKER_VERSION,
    sourceRunRefs,
    evidenceDigest,
    status,
    limitations,
    digest,
    entries,
  };

  db.insert(morningEditions).values({
    editionRef,
    profileRef: profile.ref,
    profileRevision: profile.headRevision,
    date,
    generatedAt,
    builderVersion: BUILDER_VERSION,
    rankerVersion: RANKER_VERSION,
    sourceRunRefsJson: JSON.stringify(sourceRunRefs),
    evidenceDigest,
    status,
    limitationsJson: JSON.stringify(limitations),
    digest,
  }).run();
  for (const entry of entries) {
    db.insert(morningEditionEntries).values({
      editionRef,
      position: entry.position,
      opportunityRef: entry.opportunityRef,
      marketScore: entry.marketScore,
      personalFit: entry.personalFit,
      evidenceConfidence: entry.evidenceConfidence,
      reasonCodesJson: JSON.stringify(entry.reasonCodes),
	  topic: entry.topic,
	  hookFamily: entry.hookFamily,
	  sourceRefsJson: JSON.stringify(entry.sourceRefs),
	  degraded: entry.degraded ? 1 : 0,
    }).run();
  }

  return { edition, excluded: { belowThreshold, blocked: blockedCount, suppressed: suppressedCount, noData: opps.length === 0 }, reused: false };
}

export function latestEdition(db: RadarDb, profileRef: string): EditionRecord | null {
  const row = db.select().from(morningEditions).where(eq(morningEditions.profileRef, profileRef)).orderBy(desc(morningEditions.generatedAt)).all()[0];
  return row ? hydrate(db, row) : null;
}

export function editionByRef(db: RadarDb, ref: string): EditionRecord | null {
  const row = db.select().from(morningEditions).where(eq(morningEditions.editionRef, ref)).all()[0];
  return row ? hydrate(db, row) : null;
}

function hydrate(db: RadarDb, row: typeof morningEditions.$inferSelect): EditionRecord {
  const entries = db.select().from(morningEditionEntries).where(eq(morningEditionEntries.editionRef, row.editionRef)).all()
    .sort((a, b) => a.position - b.position);
  return {
    spec: EDITION_SPEC,
    editionRef: row.editionRef,
    profileRef: row.profileRef,
    profileRevision: row.profileRevision,
    date: row.date,
    generatedAt: row.generatedAt,
    builderVersion: row.builderVersion,
    rankerVersion: row.rankerVersion,
    sourceRunRefs: JSON.parse(row.sourceRunRefsJson) as string[],
    evidenceDigest: row.evidenceDigest,
    status: row.status as EditionRecord["status"],
    limitations: JSON.parse(row.limitationsJson) as string[],
    digest: row.digest,
	entries: entries.map((entry) => {
	  const legacyOpportunity = entry.topic === "" ? opportunityByRef(db, entry.opportunityRef) : null;
	  const sourceRefs = JSON.parse(entry.sourceRefsJson) as string[];
	  return {
		position: entry.position,
		opportunityRef: entry.opportunityRef,
		topic: entry.topic || legacyOpportunity?.topic || "",
		hookFamily: entry.hookFamily || legacyOpportunity?.hookFamily || "",
		marketScore: entry.marketScore,
		personalFit: entry.personalFit,
		evidenceConfidence: entry.evidenceConfidence,
		reasonCodes: JSON.parse(entry.reasonCodesJson) as string[],
		sourceRefs: sourceRefs.length > 0 ? sourceRefs : legacyOpportunity?.sourceRefs ?? [],
		degraded: entry.degraded === 1 || legacyOpportunity?.degraded === true,
	  };
	}),
  };
}
