import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { MarketObservation, MarketSource, WorkMapping } from "../market/domain.ts";
import type { MarketSignal } from "../market/signals.ts";
import type { MarketBrief } from "../market/brief.ts";
import type { ReaderReceipt } from "../market/reader.ts";
import type { MarketWatch, WatchReceipt } from "../market/watch.ts";
import type { MarketReview } from "../market/review.ts";
import type { DecisionPack, DecisionExperiment, DecisionResult, DecisionCancellation } from "../decision/domain.ts";

export const decisionPacks = sqliteTable("decision_packs", {
  ref: text("ref").notNull(), revision: integer("revision").notNull(),
  key: text("key").notNull().unique(), requestDigest: text("request_digest").notNull(),
  profileRef: text("profile_ref"), payload: text("payload", { mode: "json" }).$type<DecisionPack>().notNull(),
}, t => [primaryKey({ columns: [t.ref, t.revision] }), index("idx_decision_profile").on(t.profileRef, t.ref, t.revision)]);

export const decisionExperiments = sqliteTable("decision_experiments", {
  ref: text("ref").primaryKey(), packRef: text("pack_ref").notNull(), sequence: integer("sequence").notNull(),
  key: text("key").notNull().unique(), requestDigest: text("request_digest").notNull(),
  payload: text("payload", { mode: "json" }).$type<DecisionExperiment>().notNull(),
}, t => [uniqueIndex("idx_decision_experiment_sequence").on(t.packRef, t.sequence)]);

export const decisionResults = sqliteTable("decision_results", {
  experimentRef: text("experiment_ref").notNull(), revision: integer("revision").notNull(),
  key: text("key").notNull().unique(), requestDigest: text("request_digest").notNull(),
  payload: text("payload", { mode: "json" }).$type<DecisionResult>().notNull(),
}, t => [primaryKey({ columns: [t.experimentRef, t.revision] })]);

export const marketReviews = sqliteTable("market_reviews", {
  ref: text("ref").primaryKey(), windowEnd: text("window_end").notNull(), cutoff: text("cutoff").notNull(),
  payload: text("payload", { mode: "json" }).$type<MarketReview>().notNull(),
}, t => [index("idx_market_review_window").on(t.windowEnd, t.cutoff)]);

export const marketWatches = sqliteTable("market_watches", {
  ref: text("ref").primaryKey(), payload: text("payload", { mode: "json" }).$type<MarketWatch>().notNull(),
});
export const marketWatchReceipts = sqliteTable("market_watch_receipts", {
  key: text("key").primaryKey(), payload: text("payload", { mode: "json" }).$type<WatchReceipt>().notNull(),
});

export const marketReaders = sqliteTable("market_readers", {
  ref: text("ref").primaryKey(), revision: integer("revision").notNull(),
});
export const marketReadMarks = sqliteTable("market_read_marks", {
  readerRef: text("reader_ref").notNull(), signalRef: text("signal_ref").notNull(),
  signalRevision: integer("signal_revision").notNull(),
}, t => [primaryKey({ columns: [t.readerRef, t.signalRef, t.signalRevision] })]);
export const marketReaderReceipts = sqliteTable("market_reader_receipts", {
  key: text("key").primaryKey(), payload: text("payload", { mode: "json" }).$type<ReaderReceipt>().notNull(),
});

export const marketBriefs = sqliteTable("market_briefs", {
  ref: text("ref").primaryKey(), windowEnd: text("window_end").notNull(),
  generatedAt: text("generated_at").notNull(),
  payload: text("payload", { mode: "json" }).$type<MarketBrief>().notNull(),
}, t => [index("idx_market_brief_window").on(t.windowEnd, t.generatedAt)]);

export const marketSignals = sqliteTable("market_signals", {
  ref: text("ref").notNull(), revision: integer("revision").notNull(),
  sourceRef: text("source_ref").notNull(), observedAt: text("observed_at").notNull(),
  fingerprint: text("fingerprint").notNull(),
  payload: text("payload", { mode: "json" }).$type<MarketSignal>().notNull(),
}, t => [
  primaryKey({ columns: [t.ref, t.revision] }),
  uniqueIndex("idx_market_signal_fingerprint").on(t.ref, t.fingerprint),
  index("idx_market_signal_time").on(t.observedAt),
]);

export const marketWorkMappings = sqliteTable("market_work_mappings", {
  ref: text("ref").notNull(), revision: integer("revision").notNull(),
  canonicalRef: text("canonical_ref"), status: text("status").notNull(),
  payload: text("payload", { mode: "json" }).$type<WorkMapping>().notNull(),
}, t => [primaryKey({ columns: [t.ref, t.revision] }), index("idx_market_mapping_canonical").on(t.canonicalRef)]);

export const marketSettings = sqliteTable("market_settings", {
  ref: text("ref").primaryKey(),
  revision: integer("revision").notNull(),
  payload: text("payload", { mode: "json" }).$type<{ timezone: string; blocked_topics: string[] }>().notNull(),
});

export const marketEvidence = sqliteTable("market_evidence", {
  ref: text("ref").primaryKey(),
  sourceRef: text("source_ref").notNull(),
  observedAt: text("observed_at").notNull(),
  payload: text("payload", { mode: "json" }).$type<{
    title: string; public_url: string; source_item_id: string; origin: string;
    // Optional per-source catalog fields; present only when the source page
    // carried them, so old rows and digests stay unchanged.
    category_label?: string; category_labels?: string[]; episode_count?: number;
  }>().notNull(),
});

export const marketSources = sqliteTable("market_sources", {
  ref: text("ref").notNull(),
  revision: integer("revision").notNull(),
  payload: text("payload", { mode: "json" }).$type<MarketSource>().notNull(),
}, t => [primaryKey({ columns: [t.ref, t.revision] })]);

// Even an empty observation batch has a receipt: it must not disappear
// into the same state as a source that was never queried.
export const marketBatches = sqliteTable("market_batches", {
  ref: text("ref").primaryKey(),
  sourceRef: text("source_ref").notNull(),
  sourceRevision: integer("source_revision").notNull(),
  observedAt: text("observed_at").notNull(),
  origin: text("origin").$type<"fixture" | "manual" | "live">().notNull(),
  digest: text("digest").notNull(),
  observationRefs: text("observation_refs", { mode: "json" }).$type<string[]>().notNull(),
}, t => [index("idx_market_batches_source_time").on(t.sourceRef, t.observedAt)]);

export const marketObservations = sqliteTable("market_observations", {
  ref: text("ref").primaryKey(),
  batchRef: text("batch_ref").notNull(),
  sourceRef: text("source_ref").notNull(),
  sourceRevision: integer("source_revision").notNull(),
  itemId: text("item_id").notNull(),
  observedAt: text("observed_at").notNull(),
  market: text("market").notNull(),
  origin: text("origin").$type<"fixture" | "manual" | "live">().notNull(),
  payload: text("payload", { mode: "json" }).$type<MarketObservation>().notNull(),
}, t => [
  uniqueIndex("idx_market_observation_identity").on(t.sourceRef, t.sourceRevision, t.itemId, t.observedAt, t.market, t.origin),
  index("idx_market_observation_source_time").on(t.sourceRef, t.observedAt),
  index("idx_market_observation_market_time").on(t.market, t.observedAt),
]);

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

export const radarAssignments = sqliteTable("radar_assignments", {
  ref: text("ref").primaryKey(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  profileRef: text("profile_ref").notNull(),
  profileRevision: integer("profile_revision").notNull(),
  editionRef: text("edition_ref").notNull(),
  opportunityRef: text("opportunity_ref"),
  briefRef: text("brief_ref"),
  status: text("status").notNull(),
  payload: text("payload", { mode: "json" }).$type<import("../pipeline/assignment.ts").ProductionAssignment>().notNull(),
  createdAt: text("created_at").notNull(),
});

// Owner-scoped intake control state. Only credential digests are persisted.
export const inputRequests = sqliteTable("input_requests", {
 id: text("id").primaryKey(), revision: integer("revision").notNull(), project: text("project").notNull(), payload: text("payload").notNull(),
});

export const marketSamplingChecks = sqliteTable("market_sampling_checks", {
  batchRef: text("batch_ref").primaryKey(),
  payload: text("payload", { mode: "json" }).$type<import("../market/sampling.ts").SamplingCheck>().notNull(),
});
export const marketSamplingPlans = sqliteTable("market_sampling_plans", {
  sourceRef: text("source_ref").notNull(), sourceRevision: integer("source_revision").notNull(),
  payload: text("payload", { mode: "json" }).$type<import("../market/sampling.ts").SamplingPlan>().notNull(),
}, table => [primaryKey({ columns: [table.sourceRef, table.sourceRevision] })]);
export const marketQualificationRecords = sqliteTable("market_qualification_records", {
  ref: text("ref").primaryKey(), sourceRef: text("source_ref").notNull(),
  payload: text("payload", { mode: "json" }).$type<import("../market/qualification.ts").QualificationRecord>().notNull(),
});
export const marketSourceReviews = sqliteTable("market_source_reviews", {
  key: text("key").primaryKey(),
  payload: text("payload", { mode: "json" }).$type<import("../market/source-review.ts").SourceReviewReceipt>().notNull(),
});

// Immutable ingestion-gate decisions (radar.work_gate_decision.v1). One row
// per recorded evaluation; rows are never updated or deleted.
export const marketWorkGateDecisions = sqliteTable("market_work_gate_decisions", {
  ref: text("ref").primaryKey(),
  workRef: text("work_ref").notNull(),
  mappingRevision: integer("mapping_revision").notNull(),
  gateVersion: text("gate_version").notNull(),
  verdict: text("verdict").notNull(),
  evaluatedAt: text("evaluated_at").notNull(),
  payload: text("payload", { mode: "json" }).$type<import("../market/gate.ts").WorkGateDecision>().notNull(),
}, t => [
  index("idx_market_gate_decisions_work").on(t.workRef, t.evaluatedAt),
  index("idx_market_gate_decisions_version").on(t.gateVersion, t.workRef),
]);

// Idempotency receipts for batch reviews (radar.work_review_batch_receipt.v1).
export const marketWorkReviewBatchReceipts = sqliteTable("market_work_review_batch_receipts", {
  key: text("key").primaryKey(),
  payload: text("payload", { mode: "json" }).$type<import("../market/review-batch.ts").WorkReviewBatchReceipt>().notNull(),
});

// Per-batch parsing quality records (radar.observation_quality.v1), written in
// the same transaction as the observation batch. One row per batch; historical
// batches without a row are reported as quality_unavailable, never backfilled.
export const marketObservationQuality = sqliteTable("market_observation_quality", {
  batchRef: text("batch_ref").primaryKey(),
  sourceRef: text("source_ref").notNull(),
  observedAt: text("observed_at").notNull(),
  payload: text("payload", { mode: "json" }).$type<import("../market/quality.ts").ObservationQualityRecord>().notNull(),
}, t => [index("idx_market_observation_quality_source_time").on(t.sourceRef, t.observedAt)]);

// PG archive sync cursors (radar market sync --to pg). One row per allowlisted
// table; the only SQLite state the sync writes. The fingerprint never carries
// credentials — it is sha256(host|port|db|schema) by construction.
export const marketSyncState = sqliteTable("market_sync_state", {
  tableName: text("table_name").primaryKey(),
  cursorJson: text("cursor_json"), // keyset position of the last committed chunk
  targetFingerprint: text("target_fingerprint").notNull(),
  rowsSynced: integer("rows_synced").notNull().default(0),
  lastSyncedAt: text("last_synced_at").notNull().default(""),
});

export const decisionCancellations = sqliteTable("decision_cancellations", {
  experimentRef: text("experiment_ref").primaryKey(), key: text("key").notNull().unique(),
  requestDigest: text("request_digest").notNull(),
  payload: text("payload", { mode: "json" }).$type<DecisionCancellation>().notNull(),
});

export const marketTitleTranslations = sqliteTable("market_title_translations", {
  workRef: text("work_ref").notNull(), targetLocale: text("target_locale").notNull(), revision: integer("revision").notNull(),
  key: text("key").notNull().unique(), requestDigest: text("request_digest").notNull(),
  payload: text("payload", { mode: "json" }).$type<import("../market/translation.ts").TitleTranslation>().notNull(),
}, t => [primaryKey({ columns: [t.workRef, t.targetLocale, t.revision] })]);

export const readingJudgments = sqliteTable("reading_judgments", {
  attemptKey: text("attempt_key").primaryKey(),
  requestId: text("request_id").notNull(),
  attemptId: text("attempt_id").notNull(),
  target: text("target").notNull(),
  createdAt: text("created_at").notNull(),
  payload: text("payload", { mode: "json" }).$type<import("../judgment/consumer.ts").ReadingJudgmentRecord>().notNull(),
});
