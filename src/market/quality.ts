import { and, eq, gte, lt } from "drizzle-orm";
import type { RadarDb } from "../db/client.ts";
import { marketBatches, marketObservationQuality } from "../db/schema.ts";
import { isMarketInstant, type MarketObservation, type MarketSource } from "./domain.ts";
import { marketDigest, MarketStoreError } from "./repository.ts";

// Observation parsing quality, persisted in the same transaction as the
// observation batch itself. One immutable record per batch; replays reuse the
// stored record, and historical batches written before this contract stay
// explicitly quality_unavailable instead of being backfilled.

export const OBSERVATION_QUALITY_SPEC = "radar.observation_quality.v1" as const;

// Parser versions: the hongguo work-card anchor layout from Lane A
// (radar-hongguo-catalog-parsing-v1) versus the generic anchor/heading/markdown
// link extraction every other source uses.
export const GENERIC_CATALOG_PARSER_VERSION = "catalog-links.v1";

export interface ObservationQualityRecord {
  spec: typeof OBSERVATION_QUALITY_SPEC;
  quality_ref: string;
  batch_ref: string;
  source_ref: string;
  source_revision: number;
  observed_at: string;
  origin: MarketObservation["origin"];
  parser_version: string;
  items: number;
  // Per-field presence over the batch items; a low count is recorded as-is,
  // never implied or padded.
  field_coverage: Record<string, { present: number; total: number }>;
  skipped: { foreign_or_unsafe_link: number; no_work_identity: number; title_invalid: number };
  digest: string;
}

export function persistObservationQuality(db: RadarDb, input: {
  batch_ref: string;
  source: MarketSource;
  observed_at: string;
  origin: MarketObservation["origin"];
  parser_version: string;
  items: number;
  field_coverage: Record<string, { present: number; total: number }>;
  skipped: { foreign_or_unsafe_link: number; no_work_identity: number; title_invalid: number };
}): { record: ObservationQualityRecord; reused: boolean } {
  const opaque = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(v);
  if (!input || !opaque(input.batch_ref) || !opaque(input.parser_version) ||
    !isMarketInstant(input.observed_at) || !["fixture", "manual", "live"].includes(input.origin) ||
    !Number.isSafeInteger(input.items) || input.items < 0) {
    throw new MarketStoreError("observation_invalid", "Invalid observation quality metadata.");
  }
  for (const [field, coverage] of Object.entries(input.field_coverage)) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(field) || !Number.isSafeInteger(coverage.present) || !Number.isSafeInteger(coverage.total) ||
      coverage.present < 0 || coverage.total < 0 || coverage.present > coverage.total) {
      throw new MarketStoreError("observation_invalid", "Field coverage must be present/total counts per field.");
    }
  }
  const observedAt = new Date(input.observed_at).toISOString();
  const record: ObservationQualityRecord = {
    spec: OBSERVATION_QUALITY_SPEC,
    quality_ref: "obs-quality-" + marketDigest([input.batch_ref]).slice(7, 39),
    batch_ref: input.batch_ref,
    source_ref: input.source.source_ref,
    source_revision: input.source.revision,
    observed_at: observedAt,
    origin: input.origin,
    parser_version: input.parser_version,
    items: input.items,
    field_coverage: Object.fromEntries(Object.entries(input.field_coverage).sort(([a], [b]) => a.localeCompare(b))),
    skipped: input.skipped,
    digest: "",
  };
  record.digest = marketDigest({ ...record, digest: "" });
  const existing = db.select().from(marketObservationQuality).where(eq(marketObservationQuality.batchRef, input.batch_ref)).get();
  if (existing) {
    // Batch replays reuse the stored record; a digest mismatch means the same
    // batch ref was produced from different parsing output, which is a real
    // conflict, not a second row.
    if (existing.payload.digest !== record.digest) {
      throw new MarketStoreError("idempotency_conflict", "Batch already has a quality record with different content.");
    }
    return { record: existing.payload, reused: true };
  }
  db.insert(marketObservationQuality).values({
    batchRef: record.batch_ref, sourceRef: record.source_ref, observedAt: record.observed_at, payload: record,
  }).run();
  return { record, reused: false };
}

export function observationQualityForBatch(db: RadarDb, batchRef: string): ObservationQualityRecord | null {
  return db.select().from(marketObservationQuality).where(eq(marketObservationQuality.batchRef, batchRef)).get()?.payload ?? null;
}

export interface SourceQualityWindow {
  source_ref: string;
  batches_in_window: number;
  quality_records: number;
  missing_records: number;
  // Explicit marker for historical batches that predate quality persistence;
  // they are excluded from ratios, never counted as zero coverage.
  quality_unavailable: boolean;
  coverage_first: number | null;
  coverage_last: number | null;
  coverage_average: number | null;
  skip_rate_first: number | null;
  skip_rate_last: number | null;
  previous_window_coverage: number | null;
  regression_flagged: boolean;
}

export const QUALITY_REGRESSION_VERSION = "quality-regression.v1" as const;
// A visible alert, never a build or command failure gate.
export const QUALITY_REGRESSION_THRESHOLD = 0.10;

function coverageRatio(record: ObservationQualityRecord): number | null {
  let present = 0, total = 0;
  for (const field of Object.values(record.field_coverage)) { present += field.present; total += field.total; }
  return total === 0 ? null : present / total;
}

function skipRate(record: ObservationQualityRecord): number | null {
  const skipped = record.skipped.foreign_or_unsafe_link + record.skipped.no_work_identity + record.skipped.title_invalid;
  const denominator = record.items + skipped;
  return denominator === 0 ? null : skipped / denominator;
}

function averageCoverage(records: ObservationQualityRecord[]): number | null {
  let present = 0, total = 0;
  for (const record of records) {
    for (const field of Object.values(record.field_coverage)) { present += field.present; total += field.total; }
  }
  return total === 0 ? null : present / total;
}

// Per-source quality comparison between a window and the previous equal-length
// window. Windows are UTC instants; callers pass the health report window.
export function marketObservationQualityWindows(db: RadarDb, start: string, end: string): {
  version: typeof QUALITY_REGRESSION_VERSION;
  threshold: number;
  sources: SourceQualityWindow[];
} {
  if (!isMarketInstant(start) || !isMarketInstant(end) || Date.parse(start) >= Date.parse(end)) {
    throw new MarketStoreError("window_invalid", "Use an increasing UTC window.");
  }
  const from = new Date(start).toISOString(), until = new Date(end).toISOString();
  const span = Date.parse(until) - Date.parse(from);
  const previousFrom = new Date(Date.parse(from) - span).toISOString();
  const batches = db.select().from(marketBatches).where(and(
    gte(marketBatches.observedAt, from), lt(marketBatches.observedAt, until))).all();
  const sources: SourceQualityWindow[] = [];
  const bySourceRef = [...new Set(batches.map(batch => batch.sourceRef))].sort();
  for (const sourceRef of bySourceRef) {
    const windowBatches = batches.filter(batch => batch.sourceRef === sourceRef)
      .sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.ref.localeCompare(b.ref));
    const records = windowBatches
      .map(batch => observationQualityForBatch(db, batch.ref))
      .filter((record): record is ObservationQualityRecord => record !== null);
    const previousRecords = db.select().from(marketObservationQuality).where(and(
      eq(marketObservationQuality.sourceRef, sourceRef),
      gte(marketObservationQuality.observedAt, previousFrom), lt(marketObservationQuality.observedAt, from),
    )).all().map(row => row.payload);
    const ratios = records.map(coverageRatio).filter((ratio): ratio is number => ratio !== null);
    const skips = records.map(skipRate).filter((rate): rate is number => rate !== null);
    const current = averageCoverage(records);
    const previous = averageCoverage(previousRecords);
    sources.push({
      source_ref: sourceRef,
      batches_in_window: windowBatches.length,
      quality_records: records.length,
      missing_records: windowBatches.length - records.length,
      quality_unavailable: records.length < windowBatches.length,
      coverage_first: ratios[0] ?? null,
      coverage_last: ratios[ratios.length - 1] ?? null,
      coverage_average: current,
      skip_rate_first: skips[0] ?? null,
      skip_rate_last: skips[skips.length - 1] ?? null,
      previous_window_coverage: previous,
      // Without a comparable previous window there is no regression verdict;
      // missing data is reported, never treated as zero coverage.
      regression_flagged: current !== null && previous !== null && previous - current > QUALITY_REGRESSION_THRESHOLD,
    });
  }
  return { version: QUALITY_REGRESSION_VERSION, threshold: QUALITY_REGRESSION_THRESHOLD, sources };
}
