import { and, eq } from "drizzle-orm";
import type { RadarDb } from "../db/client.ts";
import { marketBatches, marketEvidence, marketSamplingChecks, marketSamplingPlans } from "../db/schema.ts";
import { isMarketInstant } from "./domain.ts";
import { marketDigest, MarketStoreError, sourceByRef } from "./repository.ts";

export interface SamplingPlan {
  source_ref: string; source_revision: number; sampling_scope: string;
  utc_slots: string[]; registered_at: string; rule_version: "fixed-utc-slots.v1";
}
export function samplingPlan(db: RadarDb, sourceRef: string, revision: number) {
  return db.select().from(marketSamplingPlans).where(and(eq(marketSamplingPlans.sourceRef, sourceRef),
    eq(marketSamplingPlans.sourceRevision, revision))).get()?.payload ?? null;
}
export function registerSamplingPlan(db: RadarDb, sourceRef: string, revision: number, slots: string[], now = new Date()) {
  if (!Number.isSafeInteger(revision) || revision < 1 || !Number.isFinite(now.getTime()) || !Array.isArray(slots) ||
    slots.length < 2 || slots.length > 24 || slots.some(slot => typeof slot !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(slot))) {
    throw new MarketStoreError("sampling_plan_invalid", "Provide a source revision and 2–24 unique UTC slots in HH:mm format.");
  }
  const normalized = [...new Set(slots)].sort();
  const minutes = (slot: string) => Number(slot.slice(0, 2)) * 60 + Number(slot.slice(3));
  if (normalized.length !== slots.length || minutes(normalized.at(-1)!) - minutes(normalized[0]) < 720) {
    throw new MarketStoreError("sampling_plan_invalid", "Use unique slots spanning at least twelve hours.");
  }
  return db.transaction(tx => {
    const source = sourceByRef(tx, sourceRef);
    if (!source || source.revision !== revision) throw new MarketStoreError("state_conflict", "Read the current source revision before registering its sampling plan.");
    const prior = samplingPlan(tx, sourceRef, revision);
    if (prior) {
      if (marketDigest(prior.utc_slots) !== marketDigest(normalized) || prior.sampling_scope !== source.sampling_scope) {
        throw new MarketStoreError("sampling_plan_immutable", "Create a new source revision before changing the fixed sampling plan.");
      }
      return { plan: prior, reused: true };
    }
    const plan: SamplingPlan = { source_ref: sourceRef, source_revision: revision, sampling_scope: source.sampling_scope,
      utc_slots: normalized, registered_at: now.toISOString(), rule_version: "fixed-utc-slots.v1" };
    tx.insert(marketSamplingPlans).values({ sourceRef, sourceRevision: revision, payload: plan }).run();
    return { plan, reused: false };
  }, { behavior: "immediate" });
}

export interface SamplingCheck {
  batch_ref: string; scheduled_at: string; checked_at: string;
  completeness: "complete" | "partial"; stable_ids: boolean;
  metric_contract_valid: boolean; failure_sample_ref: string;
}

// Owner-provided checks attest to sampling quality, never change batch origin.
export function recordSamplingCheck(db: RadarDb, input: SamplingCheck, now = new Date()) {
  if (!input || Object.keys(input).some(key => !["batch_ref", "scheduled_at", "checked_at", "completeness", "stable_ids", "metric_contract_valid", "failure_sample_ref"].includes(key)) ||
    !Number.isFinite(now.getTime()) || !isMarketInstant(input.scheduled_at) || !isMarketInstant(input.checked_at) ||
    Date.parse(input.checked_at) > now.getTime() || !["complete", "partial"].includes(input.completeness) ||
    typeof input.stable_ids !== "boolean" || typeof input.metric_contract_valid !== "boolean" ||
    typeof input.batch_ref !== "string" || typeof input.failure_sample_ref !== "string") {
    throw new MarketStoreError("sampling_invalid", "Provide valid sampling times, completeness, ID/metric checks and stored failure evidence.");
  }
  return db.transaction(tx => {
    const batch = tx.select().from(marketBatches).where(eq(marketBatches.ref, input.batch_ref)).get();
    const evidence = tx.select().from(marketEvidence).where(eq(marketEvidence.ref, input.failure_sample_ref)).get();
    if (!batch || !evidence || evidence.sourceRef !== batch.sourceRef ||
      Date.parse(evidence.observedAt) > Date.parse(input.checked_at) ||
      Date.parse(batch.observedAt) < Date.parse(input.scheduled_at) || Date.parse(batch.observedAt) > Date.parse(input.checked_at)) {
      throw new MarketStoreError("sampling_evidence_invalid", "Sampling checks must reference the batch source and evidence available by check time.");
    }
    const check = { ...input, scheduled_at: new Date(input.scheduled_at).toISOString(), checked_at: new Date(input.checked_at).toISOString() };
    const prior = tx.select().from(marketSamplingChecks).where(eq(marketSamplingChecks.batchRef, input.batch_ref)).get();
    if (prior) {
      if (marketDigest(prior.payload) !== marketDigest(check)) throw new MarketStoreError("idempotency_conflict", "Batch sampling check is immutable; retain the original evidence.");
      return { check: prior.payload, reused: true };
    }
    tx.insert(marketSamplingChecks).values({ batchRef: input.batch_ref, payload: check }).run();
    return { check, reused: false };
  }, { behavior: "immediate" });
}
