import { eq } from "drizzle-orm";
import type { RadarDb } from "../db/client.ts";
import { marketBatches, marketEvidence, marketSamplingChecks, marketSourceReviews } from "../db/schema.ts";
import type { MarketSource } from "./domain.ts";
import { marketDigest, MarketStoreError, saveSource, sourceByRef } from "./repository.ts";

export interface SourceReviewInput {
  key: string; source_ref: string; revision: number; stage: "identity" | "sample" | "blocked";
  reason: string; evidence_refs: string[]; batch_ref?: string;
}
export interface SourceReviewReceipt {
  spec: "radar.market_source_review.v1"; key: string; payload_digest: string;
  reviewed_at: string; input: SourceReviewInput; source: MarketSource;
}
export function sourceReviewReceipt(db: RadarDb, key: string) {
  const row = db.select().from(marketSourceReviews).where(eq(marketSourceReviews.key, key)).get();
  if (!row) throw new MarketStoreError("receipt_not_found", "Source review receipt does not exist.");
  return row.payload;
}
export function reviewSource(db: RadarDb, input: SourceReviewInput, now = new Date()) {
  const ref = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(v);
  if (!input || Object.keys(input).some(k => !["key", "source_ref", "revision", "stage", "reason", "evidence_refs", "batch_ref"].includes(k)) ||
    !ref(input.key) || !ref(input.source_ref) || !Number.isSafeInteger(input.revision) || input.revision < 1 ||
    !["identity", "sample", "blocked"].includes(input.stage) || typeof input.reason !== "string" ||
    !input.reason.trim() || input.reason.length > 500 || !Array.isArray(input.evidence_refs) || input.evidence_refs.length > 10 ||
    input.evidence_refs.some(e => !ref(e)) || !Number.isFinite(now.getTime()) ||
    (input.stage !== "blocked" && !input.evidence_refs.length) ||
    (input.stage === "sample" ? !ref(input.batch_ref) : input.batch_ref !== undefined)) {
    throw new MarketStoreError("source_review_invalid", "Provide a source revision, stage, key, bounded reason and evidence; sample review also needs a batch.");
  }
  const normalized = { ...input, reason: input.reason.trim(), evidence_refs: [...new Set(input.evidence_refs)].sort() };
  const digest = marketDigest(normalized);
  return db.transaction(tx => {
    const prior = tx.select().from(marketSourceReviews).where(eq(marketSourceReviews.key, input.key)).get();
    if (prior) {
      if (prior.payload.payload_digest !== digest) throw new MarketStoreError("idempotency_conflict", "Source review key was used with different parameters.");
      return { receipt: prior.payload, reused: true };
    }
    const source = sourceByRef(tx, input.source_ref);
    if (!source || source.revision !== input.revision) throw new MarketStoreError("state_conflict", "Read the current source revision before review.");
    for (const evidenceRef of normalized.evidence_refs) {
      const evidence = tx.select().from(marketEvidence).where(eq(marketEvidence.ref, evidenceRef)).get();
      if (!evidence || evidence.sourceRef !== source.source_ref || evidence.payload.origin === "fixture" || Date.parse(evidence.observedAt) > now.getTime()) {
        throw new MarketStoreError("review_evidence_invalid", "Use stored non-fixture evidence for this source available by review time.");
      }
    }
    if (input.stage === "sample") {
      if (source.readiness !== "identity_verified") throw new MarketStoreError("identity_review_required", "Verify source identity before reviewing its sample.");
      const batch = tx.select().from(marketBatches).where(eq(marketBatches.ref, input.batch_ref!)).get();
      const check = tx.select().from(marketSamplingChecks).where(eq(marketSamplingChecks.batchRef, input.batch_ref!)).get()?.payload;
      if (!batch || batch.sourceRef !== source.source_ref || batch.sourceRevision !== source.revision || batch.origin === "fixture" ||
        !batch.observationRefs.length || !check || check.completeness !== "complete" || !check.stable_ids || !check.metric_contract_valid ||
        Date.parse(check.checked_at) > now.getTime() || !normalized.evidence_refs.includes(check.failure_sample_ref)) {
        throw new MarketStoreError("sample_review_invalid", "Use a non-fixture batch with complete ID/metric checks and its reviewed failure sample.");
      }
    }
    const next = saveSource(tx, { ...source, revision: source.revision + 1,
      readiness: input.stage === "identity" ? "identity_verified" : input.stage === "sample" ? "sample_verified" : "blocked",
      official_identity_evidence: input.stage === "identity" ? normalized.evidence_refs : source.official_identity_evidence,
      limitations: [...source.limitations, normalized.reason],
    }, source.revision);
    const receipt: SourceReviewReceipt = { spec: "radar.market_source_review.v1", key: input.key,
      payload_digest: digest, reviewed_at: now.toISOString(), input: normalized, source: next };
    tx.insert(marketSourceReviews).values({ key: input.key, payload: receipt }).run();
    return { receipt, reused: false };
  }, { behavior: "immediate" });
}
