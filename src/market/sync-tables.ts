import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import {
  marketBatches, marketBriefs, marketEvidence, marketObservations, marketQualificationRecords,
  marketReviews, marketSamplingChecks, marketSamplingPlans, marketSignals, marketSourceReviews,
  marketSources, marketWorkMappings,
} from "../db/schema.ts";

// Single source of truth for the PG archive sync surface (design §2): the 12
// allowlisted market tables, their columns, idempotency keys (= SQLite primary
// keys) and cursor sort keys. The PG mirror schema and its DDL are generated
// from these definitions; personal/local state tables are never listed here.

export type SyncColumnKind = "text" | "integer" | "json";

export interface SyncColumnDef {
  name: string;
  kind: SyncColumnKind; // json columns are stored as TEXT on both dialects
  nullable?: boolean;
}

export interface SyncTableDef {
  name: string;
  columns: SyncColumnDef[];
  /** Primary key shared by SQLite and the PG mirror (= ON CONFLICT target). */
  idempotencyKey: string[];
  /** Deterministic keyset order for chunked reads; ends in the idempotency key. */
  cursorOrder: string[];
  /** Columns whose values form the payload_digest input (business content). */
  digestColumns: string[];
}

const col = (name: string, kind: SyncColumnKind = "text", nullable = false): SyncColumnDef =>
  nullable ? { name, kind, nullable: true } : { name, kind };

export const MARKET_SYNC_TABLES: readonly SyncTableDef[] = [
  {
    name: "market_sources",
    columns: [col("ref"), col("revision", "integer"), col("payload", "json")],
    idempotencyKey: ["ref", "revision"],
    cursorOrder: ["ref", "revision"],
    digestColumns: ["payload"],
  },
  {
    name: "market_batches",
    columns: [col("ref"), col("source_ref"), col("source_revision", "integer"), col("observed_at"), col("origin"), col("digest"), col("observation_refs", "json")],
    idempotencyKey: ["ref"],
    cursorOrder: ["observed_at", "ref"],
    digestColumns: ["source_ref", "source_revision", "observed_at", "origin", "digest", "observation_refs"],
  },
  {
    name: "market_observations",
    columns: [col("ref"), col("batch_ref"), col("source_ref"), col("source_revision", "integer"), col("item_id"), col("observed_at"), col("market"), col("origin"), col("payload", "json")],
    idempotencyKey: ["ref"],
    cursorOrder: ["observed_at", "ref"],
    digestColumns: ["payload"],
  },
  {
    name: "market_evidence",
    columns: [col("ref"), col("source_ref"), col("observed_at"), col("payload", "json")],
    idempotencyKey: ["ref"],
    cursorOrder: ["observed_at", "ref"],
    digestColumns: ["payload"],
  },
  {
    name: "market_signals",
    columns: [col("ref"), col("revision", "integer"), col("source_ref"), col("observed_at"), col("fingerprint"), col("payload", "json")],
    idempotencyKey: ["ref", "revision"],
    cursorOrder: ["observed_at", "ref", "revision"],
    digestColumns: ["payload"],
  },
  {
    name: "market_work_mappings",
    columns: [col("ref"), col("revision", "integer"), col("canonical_ref", "text", true), col("status"), col("payload", "json")],
    idempotencyKey: ["ref", "revision"],
    cursorOrder: ["ref", "revision"],
    digestColumns: ["payload"],
  },
  {
    name: "market_briefs",
    columns: [col("ref"), col("window_end"), col("generated_at"), col("payload", "json")],
    idempotencyKey: ["ref"],
    cursorOrder: ["generated_at", "ref"],
    digestColumns: ["payload"],
  },
  {
    name: "market_reviews",
    columns: [col("ref"), col("window_end"), col("cutoff"), col("payload", "json")],
    idempotencyKey: ["ref"],
    cursorOrder: ["window_end", "ref"],
    digestColumns: ["payload"],
  },
  {
    name: "market_sampling_plans",
    columns: [col("source_ref"), col("source_revision", "integer"), col("payload", "json")],
    idempotencyKey: ["source_ref", "source_revision"],
    cursorOrder: ["source_ref", "source_revision"],
    digestColumns: ["payload"],
  },
  {
    name: "market_sampling_checks",
    columns: [col("batch_ref"), col("payload", "json")],
    idempotencyKey: ["batch_ref"],
    cursorOrder: ["batch_ref"],
    digestColumns: ["payload"],
  },
  {
    name: "market_qualification_records",
    columns: [col("ref"), col("source_ref"), col("payload", "json")],
    idempotencyKey: ["ref"],
    cursorOrder: ["ref"],
    digestColumns: ["payload"],
  },
  {
    name: "market_source_reviews",
    columns: [col("key"), col("payload", "json")],
    idempotencyKey: ["key"],
    cursorOrder: ["key"],
    digestColumns: ["payload"],
  },
] as const;

// Explicitly out of the archive allowlist (design §2): personal reader/watch
// state, profiles/feedback, opportunities/editions, assignments, runs, the
// legacy two-platform pipeline tables and intake control state stay local.
// Ingestion-gate tables are SQLite-local in radar-market-pg-sync-v1 (frozen
// 12-table allowlist); a later change can archive them without rewriting rows.
export const MARKET_SYNC_EXCLUDED_TABLES = [
  "market_title_translations",
  "decision_packs", "decision_experiments", "decision_results", "decision_cancellations",
  "market_readers", "market_read_marks", "market_reader_receipts",
  "market_watches", "market_watch_receipts", "market_settings",
  "personal_profiles", "personal_profile_revisions", "preference_feedback",
  "opportunities", "opportunity_items", "morning_editions", "morning_edition_entries",
  "opportunity_reviews", "radar_assignments", "runs",
  "raw_snapshots", "daily_items", "input_requests", "market_sync_state",
  "market_work_gate_decisions", "market_work_review_batch_receipts", "market_observation_quality",
] as const;

const SQLITE_TABLES: Record<string, SQLiteTable> = {
  market_sources: marketSources,
  market_batches: marketBatches,
  market_observations: marketObservations,
  market_evidence: marketEvidence,
  market_signals: marketSignals,
  market_work_mappings: marketWorkMappings,
  market_briefs: marketBriefs,
  market_reviews: marketReviews,
  market_sampling_plans: marketSamplingPlans,
  market_sampling_checks: marketSamplingChecks,
  market_qualification_records: marketQualificationRecords,
  market_source_reviews: marketSourceReviews,
};

export function syncTableDef(name: string): SyncTableDef {
  const def = MARKET_SYNC_TABLES.find(t => t.name === name);
  if (!def) throw new Error(`unknown sync table '${name}'`);
  return def;
}

export function sqliteTableFor(def: SyncTableDef): SQLiteTable {
  return SQLITE_TABLES[def.name]!;
}
