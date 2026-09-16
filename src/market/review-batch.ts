import { eq } from "drizzle-orm";
import type { RadarDb } from "../db/client.ts";
import { marketBatches, marketEvidence, marketObservations, marketWorkReviewBatchReceipts } from "../db/schema.ts";
import type { WorkMapping } from "./domain.ts";
import { marketDigest, MarketStoreError, sourceByRef } from "./repository.ts";
import { listWorkMappings, workSubjectRef } from "./identity.ts";
import {
  CURRENT_GATE_VERSION, evaluateWorkGate, recordGateDecision, gateRuleSet,
  type GateReasonCode, type WorkGateDecision,
} from "./gate.ts";

// Batch review: one owner action records a gate decision for every candidate
// in a source (optionally narrowed to one observation batch) inside a single
// transaction, and returns an idempotent receipt for disconnect recovery.
// Batch review only records decisions; promotion stays a per-work action.

export const WORK_REVIEW_BATCH_RECEIPT_SPEC = "radar.work_review_batch_receipt.v1" as const;

export interface WorkReviewBatchReceipt {
  spec: typeof WORK_REVIEW_BATCH_RECEIPT_SPEC;
  idempotency_key: string;
  payload_digest: string;
  scope: { source_ref: string; batch_ref: string | null; gate_version: string };
  evaluated: number;
  promotable: number;
  rejected: number;
  reason_distribution: Partial<Record<GateReasonCode, number>>;
  decision_refs: string[];
  created_at: string;
}

const KEY_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

// Candidate mappings in scope. A mapping belongs to a source when its
// supporting evidence was collected from that source; a batch narrows the
// scope to works observed in that batch.
export function gateScopeCandidates(db: RadarDb, scope: { source_ref?: string; batch_ref?: string }): WorkMapping[] {
  let candidates = listWorkMappings(db, "candidate");
  if (scope.source_ref !== undefined) {
    const source = sourceByRef(db, scope.source_ref);
    if (!source) throw new MarketStoreError("source_not_found", "Run 'radar market init' before reviewing works.");
    const evidenceRows = db.select({ ref: marketEvidence.ref, sourceRef: marketEvidence.sourceRef })
      .from(marketEvidence).where(eq(marketEvidence.sourceRef, source.source_ref)).all();
    const sourceEvidence = new Set(evidenceRows.map(row => row.ref));
    candidates = candidates.filter(mapping => mapping.supporting_evidence_refs.some(ref => sourceEvidence.has(ref)));
  }
  if (scope.batch_ref !== undefined) {
    const batch = db.select().from(marketBatches).where(eq(marketBatches.ref, scope.batch_ref)).get();
    if (!batch) throw new MarketStoreError("batch_not_found", "No observation batch exists for this ref.");
    if (scope.source_ref !== undefined && batch.sourceRef !== scope.source_ref) {
      throw new MarketStoreError("batch_not_found", "The batch belongs to a different source.");
    }
    const rows = db.select({ itemId: marketObservations.itemId }).from(marketObservations)
      .where(eq(marketObservations.batchRef, batch.ref)).all();
    const subjects = new Set(rows.map(row => workSubjectRef(batch.sourceRef, row.itemId)));
    candidates = candidates.filter(mapping => subjects.has(mapping.platform_work_ref));
  }
  return candidates.sort((a, b) => a.platform_work_ref.localeCompare(b.platform_work_ref));
}

export function reviewWorkBatch(db: RadarDb, input: {
  source_ref: string; batch_ref?: string; key: string;
}, now = new Date()): { receipt: WorkReviewBatchReceipt; reused: boolean } {
  if (!input || !KEY_SHAPE.test(input.source_ref ?? "") || !KEY_SHAPE.test(input.key ?? "") ||
    (input.batch_ref !== undefined && !KEY_SHAPE.test(input.batch_ref)) || !Number.isFinite(now.getTime())) {
    throw new MarketStoreError("review_invalid", "Provide a source ref, an idempotency key and an optional batch ref.");
  }
  const gateVersion = CURRENT_GATE_VERSION;
  gateRuleSet(gateVersion);
  const scope = { source_ref: input.source_ref, batch_ref: input.batch_ref ?? null, gate_version: gateVersion };
  const payloadDigest = marketDigest(scope);
  return db.transaction(tx => {
    // Disconnect recovery: reconcile by key before any write. Same key and
    // same scope replay returns the original receipt with zero new decisions;
    // same key with a different scope is a conflict, never a silent second run.
    const existing = tx.select().from(marketWorkReviewBatchReceipts)
      .where(eq(marketWorkReviewBatchReceipts.key, input.key)).get();
    if (existing) {
      if (existing.payload.payload_digest !== payloadDigest) {
        throw new MarketStoreError("idempotency_conflict",
          "Key was already used for a different review scope; query the original receipt with 'radar market work review-batch-receipt --key " + input.key + "'.");
      }
      return { receipt: existing.payload, reused: true };
    }
    const candidates = gateScopeCandidates(tx, { source_ref: input.source_ref, ...(input.batch_ref !== undefined ? { batch_ref: input.batch_ref } : {}) });
    const decisions: WorkGateDecision[] = [];
    for (const mapping of candidates) {
      decisions.push(recordGateDecision(tx, evaluateWorkGate(tx, mapping.platform_work_ref, gateVersion),
        { kind: "review_batch", receipt_key: input.key }, now.toISOString()).decision);
    }
    const distribution: Partial<Record<GateReasonCode, number>> = {};
    for (const decision of decisions) {
      for (const code of decision.reason_codes) distribution[code] = (distribution[code] ?? 0) + 1;
    }
    const receipt: WorkReviewBatchReceipt = {
      spec: WORK_REVIEW_BATCH_RECEIPT_SPEC,
      idempotency_key: input.key,
      payload_digest: payloadDigest,
      scope,
      evaluated: decisions.length,
      promotable: decisions.filter(d => d.verdict === "promotable").length,
      rejected: decisions.filter(d => d.verdict === "rejected").length,
      reason_distribution: Object.fromEntries(Object.entries(distribution).sort(([a], [b]) => a.localeCompare(b))),
      decision_refs: decisions.map(d => d.decision_ref),
      created_at: now.toISOString(),
    };
    tx.insert(marketWorkReviewBatchReceipts).values({ key: input.key, payload: receipt }).run();
    return { receipt, reused: false };
  }, { behavior: "immediate" });
}

export function reviewBatchReceipt(db: RadarDb, key: string): WorkReviewBatchReceipt | null {
  if (!KEY_SHAPE.test(key ?? "")) throw new MarketStoreError("review_invalid", "Provide the review-batch idempotency key.");
  return db.select().from(marketWorkReviewBatchReceipts).where(eq(marketWorkReviewBatchReceipts.key, key)).get()?.payload ?? null;
}

// Read-only evaluation projection over a scope: verdict distribution, reason
// counts and per-work detail. Never writes; unknown refs fail with the same
// named errors as the batch action.
export function gateReport(db: RadarDb, scope: { source_ref?: string; batch_ref?: string }, gateVersion = CURRENT_GATE_VERSION) {
  gateRuleSet(gateVersion);
  const candidates = gateScopeCandidates(db, scope);
  const works = candidates.map(mapping => evaluateWorkGate(db, mapping.platform_work_ref, gateVersion));
  const reasons: Partial<Record<GateReasonCode, number>> = {};
  for (const work of works) for (const code of work.reason_codes) reasons[code] = (reasons[code] ?? 0) + 1;
  return {
    gate_version: gateVersion,
    scope: { source_ref: scope.source_ref ?? null, batch_ref: scope.batch_ref ?? null },
    evaluated: works.length,
    verdicts: {
      promotable: works.filter(w => w.verdict === "promotable").length,
      rejected: works.filter(w => w.verdict === "rejected").length,
    },
    reason_distribution: Object.fromEntries(Object.entries(reasons).sort(([a], [b]) => a.localeCompare(b))),
    works: works.map(w => ({
      platform_work_ref: w.platform_work_ref, mapping_revision: w.mapping_revision,
      verdict: w.verdict, reason_codes: w.reason_codes,
    })),
  };
}
