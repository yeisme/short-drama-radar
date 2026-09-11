import { eq } from "drizzle-orm";
import type { RadarDb } from "../db/client.ts";
import { rawSnapshots } from "../db/schema.ts";
import { isMarketInstant, parseMarketObservation, type MarketObservation, type MarketSource, type MetricFact } from "./domain.ts";
import { marketDigest, MarketStoreError, saveObservationBatch, saveSource, sourceByRef } from "./repository.ts";

type LegacySnapshot = typeof rawSnapshots.$inferSelect;
const metricNames = new Set(["digg_count", "like_count", "liked_count", "collected_count", "comment_count", "share_count", "play_count"]);

export function legacyObservation(row: LegacySnapshot, source: MarketSource): MarketObservation {
  let metrics: unknown;
  try { metrics = JSON.parse(row.metricsJson); }
  catch { throw new MarketStoreError("observation_invalid", "Legacy snapshot metrics are not valid JSON."); }
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) throw new MarketStoreError("observation_invalid", "Legacy metrics must be an object.");
  const facts: MetricFact[] = [];
  for (const [name, value] of Object.entries(metrics)) {
    if (!metricNames.has(name)) continue; // Deltas and unknown metrics have no verified interval definition.
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new MarketStoreError("observation_invalid", "Legacy metric must be a finite nonnegative number.");
    // Never upgrade a missing XHS play count into a measured value.
    if (row.platform === "xiaohongshu" && name === "play_count") continue;
    facts.push({ name, value, unit: "count", basis: "cumulative", window: null,
      definition_version: "legacy-" + row.platform + "-v1", sample_denominator: null });
  }
  if (!isMarketInstant(row.fetchedAt)) throw new MarketStoreError("observation_invalid", "Legacy snapshot has an invalid observation time.");
  return parseMarketObservation({
    spec: "radar.market_observation.v1", observation_ref: "legacy-obs-" + row.id,
    source_ref: source.source_ref, source_revision: source.revision,
    source_item_id: row.contentId, source_snapshot_ref: "legacy-snapshot-" + row.id,
    observed_at: row.fetchedAt,
    source_published_at: isMarketInstant(row.publishedAt) ? row.publishedAt : null,
    market: "unknown", market_evidence_refs: [], locale: "zh",
    format: "unknown", production_method: "unknown", production_evidence_refs: [],
    title: row.title, topics: [], facts, evidence_refs: ["legacy-snapshot-" + row.id],
    collection_run_ref: "legacy-run-" + marketDigest(row.runId).slice(7, 31),
    // Old rows did not record fixture/live provenance. Conservative manual
    // import prevents historical test data from satisfying live qualification.
    origin: "manual",
  });
}

export function importLegacyRun(db: RadarDb, runRef: string) {
  if (!runRef || runRef.length > 200) throw new MarketStoreError("run_invalid", "Provide a bounded legacy run ref.");
  const rows = db.select().from(rawSnapshots).where(eq(rawSnapshots.runId, runRef)).orderBy(rawSnapshots.id).all();
  if (!rows.length) throw new MarketStoreError("run_not_found", "No legacy snapshots exist for this run.");
  if (rows.length > 10000) throw new MarketStoreError("batch_too_large", "Legacy run exceeds the 10000 snapshot import limit.");
  return db.transaction(tx => {
    const groups = new Map<string, { source: MarketSource; observations: MarketObservation[] }>();
    for (const row of rows) {
      if (!["douyin", "xiaohongshu"].includes(row.platform)) throw new MarketStoreError("source_invalid", "Unsupported legacy platform.");
      const sourceRef = "legacy-" + row.platform + "-" + marketDigest([row.source, row.layer]).slice(7, 23);
      let source = sourceByRef(tx, sourceRef);
      if (!source) {
        source = saveSource(tx, {
          spec: "radar.market_source.v1", source_ref: sourceRef, revision: 1,
          platform: row.platform, role: "discussion", publisher_group: row.platform,
          official_identity_evidence: [], market_scope: ["unknown"], locale: "zh",
          collection_method: "manual", metric_definitions: ["legacy-" + row.platform + "-v1"],
          sampling_scope: "Historical adapter snapshots; original collection coverage unknown",
          freshness_budget: null, readiness: "planned",
          limitations: ["Legacy fixture/live provenance was not recorded; imported data cannot qualify live collection."],
        }, 0);
      }
      const observation = legacyObservation(row, source);
      const key = marketDigest([sourceRef, observation.observed_at]);
      const group = groups.get(key) ?? { source, observations: [] };
      group.observations.push(observation);
      groups.set(key, group);
    }
    const receipts = [...groups.entries()].map(([key, group]) => saveObservationBatch(tx, {
      ref: "legacy-batch-" + marketDigest([runRef, key]).slice(7, 39),
      source_ref: group.source.source_ref, source_revision: group.source.revision,
      observed_at: group.observations[0].observed_at, origin: "manual", observations: group.observations,
    }));
    return { imported: rows.length, receipts, origin: "manual", limitations: ["Historical provenance does not prove live collection."] };
  }, { behavior: "immediate" });
}
