import { createHash } from "node:crypto";
import { and, desc, eq, gte, lt } from "drizzle-orm";
import type { RadarDb } from "../db/client.ts";
import { marketBatches, marketObservations, marketSources } from "../db/schema.ts";
import { sortKeysDeep } from "../profile/domain.ts";
import { isMarketInstant, parseMarketObservation, parseMarketSource, type MarketObservation, type MarketSource } from "./domain.ts";

export class MarketStoreError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "MarketStoreError";
  }
}

export function marketDigest(value: unknown): string {
  return "sha256:" + createHash("sha256").update(JSON.stringify(sortKeysDeep(value))).digest("hex");
}

export function sourceByRef(db: RadarDb, ref: string, revision?: number): MarketSource | null {
  const condition = revision === undefined ? eq(marketSources.ref, ref)
    : and(eq(marketSources.ref, ref), eq(marketSources.revision, revision));
  return db.select().from(marketSources).where(condition).orderBy(desc(marketSources.revision)).limit(1).get()?.payload ?? null;
}

// This repository persists structural source revisions, not qualification
// decisions. Promotion is deliberately reserved for the qualification service.
export function saveSource(db: RadarDb, input: unknown, expectedRevision: number): MarketSource {
  const source = parseMarketSource(input);
  if (source.readiness === "qualified") throw new MarketStoreError("qualification_required", "Use verified qualification evidence to promote a source.");
  return db.transaction(tx => {
    const current = sourceByRef(tx, source.source_ref);
    if (current && marketDigest(current) === marketDigest(source)) return current;
    if ((current?.revision ?? 0) !== expectedRevision || source.revision !== expectedRevision + 1) {
      throw new MarketStoreError("state_conflict", "Source revision changed; read the current source before updating.");
    }
    tx.insert(marketSources).values({ ref: source.source_ref, revision: source.revision, payload: source }).run();
    return source;
  }, { behavior: "immediate" });
}

export interface ObservationBatch {
  ref: string;
  source_ref: string;
  source_revision: number;
  observed_at: string;
  origin: MarketObservation["origin"];
  observations: unknown[];
}

export interface BatchReceipt {
  batch_ref: string;
  observation_refs: string[];
  digest: string;
  reused: boolean;
}

export function saveObservationBatch(db: RadarDb, batch: ObservationBatch): BatchReceipt {
  const opaque = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(v);
  if (!batch || !opaque(batch.ref) || !opaque(batch.source_ref) ||
    !Number.isSafeInteger(batch.source_revision) || batch.source_revision < 1 ||
    !isMarketInstant(batch.observed_at) || !["fixture", "manual", "live"].includes(batch.origin) ||
    !Array.isArray(batch.observations) || batch.observations.length > 10_000) {
    throw new MarketStoreError("observation_invalid", "Invalid observation batch metadata.");
  }
  const items = batch.observations.map(parseMarketObservation).sort((a, b) => a.observation_ref.localeCompare(b.observation_ref));
  const seen = new Set<string>();
  for (const item of items) {
    if (item.source_ref !== batch.source_ref || item.source_revision !== batch.source_revision ||
      Date.parse(item.observed_at) !== Date.parse(batch.observed_at) || item.origin !== batch.origin ||
      seen.has(item.observation_ref)) {
      throw new MarketStoreError("observation_invalid", "Batch members must match source, time and origin with unique refs.");
    }
    seen.add(item.observation_ref);
  }
  const observedAt = new Date(batch.observed_at).toISOString();
  const normalized = items.map(item => ({ ...item, observed_at: observedAt }));
  const digest = marketDigest({ source_ref: batch.source_ref, source_revision: batch.source_revision, observed_at: observedAt, origin: batch.origin, observations: normalized });
  return db.transaction(tx => {
    const prior = tx.select().from(marketBatches).where(eq(marketBatches.ref, batch.ref)).get();
    if (prior) {
      if (prior.digest !== digest) throw new MarketStoreError("idempotency_conflict", "Batch key was already used for different content.");
      return { batch_ref: prior.ref, observation_refs: prior.observationRefs, digest, reused: true };
    }
    if (!sourceByRef(tx, batch.source_ref, batch.source_revision)) throw new MarketStoreError("source_not_found", "Register the source revision before importing observations.");
    // Receipt and members share one transaction. A unique-identity conflict
    // in a later item must roll back the earlier items and the receipt.
    const refs = normalized.map(item => item.observation_ref);
    tx.insert(marketBatches).values({ ref: batch.ref, sourceRef: batch.source_ref, sourceRevision: batch.source_revision, observedAt, origin: batch.origin, digest, observationRefs: refs }).run();
    for (const item of normalized) {
      tx.insert(marketObservations).values({
        ref: item.observation_ref, batchRef: batch.ref, sourceRef: item.source_ref,
        sourceRevision: item.source_revision, itemId: item.source_item_id,
        observedAt, market: item.market, origin: item.origin, payload: item,
      }).run();
    }
    return { batch_ref: batch.ref, observation_refs: refs, digest, reused: false };
  }, { behavior: "immediate" });
}

export function observationsInWindow(db: RadarDb, sourceRef: string, start: string, end: string, limit = 100): MarketObservation[] {
  if (!isMarketInstant(start) || !isMarketInstant(end) || Date.parse(start) >= Date.parse(end) ||
    !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new MarketStoreError("window_invalid", "Use an increasing UTC window and a limit between 1 and 1000.");
  }
  return db.select().from(marketObservations).where(and(
    eq(marketObservations.sourceRef, sourceRef),
    gte(marketObservations.observedAt, new Date(start).toISOString()),
    lt(marketObservations.observedAt, new Date(end).toISOString()),
  )).orderBy(marketObservations.observedAt, marketObservations.ref).limit(limit).all().map(row => row.payload);
}
