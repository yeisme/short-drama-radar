import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Raw fetch receipts. One row per adapter item per fetch attempt.
export const rawSnapshots = sqliteTable("raw_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: text("run_id").notNull(),
  platform: text("platform").notNull(), // douyin | xiaohongshu
  layer: integer("layer").notNull(), // 0 public, 1 backend cli, 2 browser, 3 manual
  source: text("source").notNull(), // adapter name, e.g. firecrawl, agent-reach-xhs
  contentId: text("content_id").notNull(),
  title: text("title").notNull().default(""),
  url: text("url").notNull().default(""),
  authorId: text("author_id").notNull().default(""),
  authorName: text("author_name").notNull().default(""),
  publishedAt: text("published_at").notNull().default(""),
  metricsJson: text("metrics_json").notNull().default("{}"), // raw metrics snapshot
  payloadHash: text("payload_hash").notNull().default(""),
  confidence: integer("confidence").notNull().default(60), // 0-100
  degraded: integer("degraded").notNull().default(0), // 0|1
  fetchedAt: text("fetched_at").notNull(),
});

// Normalized per-day items, deduped by (date, platform, content_id).
export const dailyItems = sqliteTable("daily_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  date: text("date").notNull(), // YYYY-MM-DD
  platform: text("platform").notNull(),
  contentId: text("content_id").notNull(),
  title: text("title").notNull().default(""),
  url: text("url").notNull().default(""),
  authorId: text("author_id").notNull().default(""),
  publishedAt: text("published_at").notNull().default(""),
  metricsJson: text("metrics_json").notNull().default("{}"),
  tagsJson: text("tags_json").notNull().default("{}"), // hook/topic/emotion tags
  score: integer("score").notNull().default(0), // 0-100
  confidence: integer("confidence").notNull().default(0), // 0-100
  isNew: integer("is_new").notNull().default(0), // first seen yesterday->today window
  degraded: integer("degraded").notNull().default(0),
  sourceLayer: integer("source_layer").notNull().default(-1), // layer owning the current metrics
  updatedAt: text("updated_at").notNull(),
});

// Pipeline run receipts, written only by the CLI.
export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(), // run-<timestamp>
  kind: text("kind").notNull(), // collect | score | card | daily
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at").notNull().default(""),
  status: text("status").notNull().default("ok"), // ok | degraded | failed
  summaryJson: text("summary_json").notNull().default("{}"),
});

// Personal profiles (current head). At most one active profile at a time;
// the invariant is enforced inside the profile application service.
export const personalProfiles = sqliteTable("personal_profiles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ref: text("ref").notNull().unique(), // profile-<slug>
  name: text("name").notNull(),
  active: integer("active").notNull().default(0), // exactly one row may be 1
  headRevision: integer("head_revision").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// Immutable profile revisions; editions reference a revision, never the head.
export const personalProfileRevisions = sqliteTable("personal_profile_revisions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  profileRef: text("profile_ref").notNull(),
  revision: integer("revision").notNull(), // 1..N, monotonic per profile
  profileJson: text("profile_json").notNull(), // radar.personal_profile.v1 payload
  digest: text("digest").notNull(), // sha256 of canonical payload
  createdAt: text("created_at").notNull(),
});

// Append-only preference feedback ledger (radar.preference_feedback.v1).
export const preferenceFeedback = sqliteTable("preference_feedback", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  profileRef: text("profile_ref").notNull(),
  opportunityRef: text("opportunity_ref").notNull(),
  kind: text("kind").notNull(), // saved|used|dismissed|not_relevant|too_risky|already_seen
  matchedFeaturesJson: text("matched_features_json").notNull().default("[]"), // snapshot at feedback time
  projectRef: text("project_ref").notNull().default(""), // opaque downstream ref
  idempotencyKey: text("idempotency_key").notNull(),
  createdAt: text("created_at").notNull(),
});

// Opportunity clusters (radar.opportunity.v1) — the ranking subject.
export const opportunities = sqliteTable("opportunities", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ref: text("ref").notNull().unique(), // opp-<date>-<hash8>
  date: text("date").notNull(),
  clusterKey: text("cluster_key").notNull(), // date|topic|hook_family|format
  topic: text("topic").notNull(),
  hookFamily: text("hook_family").notNull().default(""),
  format: text("format").notNull().default("default"),
  marketScore: integer("market_score").notNull(),
  evidenceConfidence: integer("evidence_confidence").notNull(),
  degraded: integer("degraded").notNull().default(0),
  crossPlatform: integer("cross_platform").notNull().default(0),
  evidenceDigest: text("evidence_digest").notNull(),
  sourceRefsJson: text("source_refs_json").notNull().default("[]"),
  builderVersion: text("builder_version").notNull(),
  createdAt: text("created_at").notNull(),
});

// Membership: which daily items back an opportunity.
export const opportunityItems = sqliteTable("opportunity_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  opportunityRef: text("opportunity_ref").notNull(),
  dailyItemId: integer("daily_item_id").notNull(),
  platform: text("platform").notNull(),
  contentId: text("content_id").notNull(),
});

// Immutable personal morning editions (radar.morning_edition.v1).
export const morningEditions = sqliteTable("morning_editions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  editionRef: text("edition_ref").notNull().unique(), // edition-<date>-<hash8>
  profileRef: text("profile_ref").notNull(),
  profileRevision: integer("profile_revision").notNull(),
  date: text("date").notNull(),
  generatedAt: text("generated_at").notNull(),
  builderVersion: text("builder_version").notNull(),
  rankerVersion: text("ranker_version").notNull(),
  sourceRunRefsJson: text("source_run_refs_json").notNull().default("[]"),
  evidenceDigest: text("evidence_digest").notNull(),
  status: text("status").notNull(), // ready|empty|degraded
  limitationsJson: text("limitations_json").notNull().default("[]"),
  digest: text("digest").notNull(),
});

// Ranked entries of an edition (immutable with their edition).
export const morningEditionEntries = sqliteTable("morning_edition_entries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  editionRef: text("edition_ref").notNull(),
  position: integer("position").notNull(),
  opportunityRef: text("opportunity_ref").notNull(),
  marketScore: integer("market_score").notNull(),
  personalFit: integer("personal_fit").notNull(),
  evidenceConfidence: integer("evidence_confidence").notNull(),
  reasonCodesJson: text("reason_codes_json").notNull().default("[]"),
	topic: text("topic").notNull().default(""),
	hookFamily: text("hook_family").notNull().default(""),
	sourceRefsJson: text("source_refs_json").notNull().default("[]"),
	degraded: integer("degraded").notNull().default(0),
});

// Append-only opportunity review receipts.
export const opportunityReviews = sqliteTable("opportunity_reviews", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  profileRef: text("profile_ref").notNull(),
  opportunityRef: text("opportunity_ref").notNull(),
  decision: text("decision").notNull(), // accept|reject|needs_evidence
  note: text("note").notNull().default(""),
  projectRef: text("project_ref").notNull().default(""),
  idempotencyKey: text("idempotency_key").notNull(),
  createdAt: text("created_at").notNull(),
});

// Owner-scoped intake control state. Only credential digests are persisted.
export const inputRequests = sqliteTable("input_requests", {
 id: text("id").primaryKey(), revision: integer("revision").notNull(), project: text("project").notNull(), payload: text("payload").notNull(),
});
