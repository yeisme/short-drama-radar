import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { RadarDb } from "../db/client.ts";
import { preferenceFeedback } from "../db/schema.ts";
import { opportunityByRef, type BuiltOpportunity } from "./opportunity.ts";

// radar.preference_feedback.v1 — append-only preference ledger. Fixed kind
// enum, idempotent appends, bounded [-15,+15] adjustments, blocked topics
// always outrank positive feedback.

export const FEEDBACK_KINDS = ["saved", "used", "dismissed", "not_relevant", "too_risky", "already_seen"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export const KIND_SIGNAL: Record<FeedbackKind, number> = {
  saved: 2,
  used: 4,
  dismissed: -2,
  not_relevant: -4,
  too_risky: -6,
  already_seen: 0,
};

export const ADJUSTMENT_CAP = 15;

export interface FeedbackReceipt {
  id: number;
  profileRef: string;
  opportunityRef: string;
  kind: FeedbackKind;
  matchedFeatures: string[];
  projectRef: string;
  createdAt: string;
  duplicate: boolean; // true when an idempotent replay returned the original
}

export class FeedbackError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "FeedbackError";
  }
}

// Feature vector targeted by feedback: cluster topic/hook/format plus a
// stable evidence digest used by `already_seen` suppression.
export function matchedFeaturesOf(opp: BuiltOpportunity): string[] {
  return [`topic:${opp.topic}`, `hook:${opp.hookFamily}`, `format:${opp.format}`, `evidence:${opp.evidenceDigest}`];
}

export function addFeedback(
  db: RadarDb,
  input: { profileRef: string; opportunityRef: string; kind: string; projectRef?: string; idempotencyKey?: string },
  now = new Date(),
): FeedbackReceipt {
  if (!(FEEDBACK_KINDS as readonly string[]).includes(input.kind)) {
    throw new FeedbackError("feedback_kind_invalid", `kind must be one of ${FEEDBACK_KINDS.join("|")}`);
  }
  const kind = input.kind as FeedbackKind;
  const key = input.idempotencyKey ?? defaultKey(input);
  const existing = db.select().from(preferenceFeedback).where(eq(preferenceFeedback.idempotencyKey, key)).all()[0];
  if (existing) {
    // Idempotent replay: same key returns the original receipt, no new row.
    return {
      id: existing.id,
      profileRef: existing.profileRef,
      opportunityRef: existing.opportunityRef,
      kind: existing.kind as FeedbackKind,
      matchedFeatures: JSON.parse(existing.matchedFeaturesJson) as string[],
      projectRef: existing.projectRef,
      createdAt: existing.createdAt,
      duplicate: true,
    };
  }
  const features = matchedFeaturesRef(db, input.opportunityRef);
  const createdAt = now.toISOString();
  const res = db.insert(preferenceFeedback).values({
    profileRef: input.profileRef,
    opportunityRef: input.opportunityRef,
    kind,
    matchedFeaturesJson: JSON.stringify(features),
    projectRef: input.projectRef ?? "",
    idempotencyKey: key,
    createdAt,
  }).returning({ id: preferenceFeedback.id }).all();
  return { id: res[0]?.id ?? 0, profileRef: input.profileRef, opportunityRef: input.opportunityRef, kind, matchedFeatures: features, projectRef: input.projectRef ?? "", createdAt, duplicate: false };
}

function matchedFeaturesRef(db: RadarDb, opportunityRef: string): string[] {
  // Snapshot from stored clusters; unknown refs fall back to the bare ref so
  // the ledger row stays auditable.
  const opp = opportunityByRef(db, opportunityRef);
  return opp ? matchedFeaturesOf(opp) : [`ref:${opportunityRef}`];
}

// Aggregate per-feature feedback signals for a profile, clamped per feature
// to [-15, +15] and summed over the target's matched features with the same
// clamp applied to the total (bounded rerank, never a preference rewrite).
// Ranking a batch should build the adjuster once and reuse it per opportunity
// instead of rescanning the ledger per item.
export type FeedbackAdjuster = (features: string[]) => number;

export function buildFeedbackAdjuster(db: RadarDb, profileRef: string): FeedbackAdjuster {
  const rows = db.select().from(preferenceFeedback).where(eq(preferenceFeedback.profileRef, profileRef)).all();
  const perFeature = new Map<string, number>();
  for (const row of rows) {
    const featuresAtTime = JSON.parse(row.matchedFeaturesJson) as string[];
    for (const f of featuresAtTime) {
      perFeature.set(f, (perFeature.get(f) ?? 0) + KIND_SIGNAL[row.kind as FeedbackKind]);
    }
  }
  return (features: string[]) => {
    let total = 0;
    for (const f of features) {
      total += Math.max(-ADJUSTMENT_CAP, Math.min(ADJUSTMENT_CAP, perFeature.get(f) ?? 0));
    }
    return Math.max(-ADJUSTMENT_CAP, Math.min(ADJUSTMENT_CAP, total));
  };
}

export function feedbackAdjustment(db: RadarDb, profileRef: string, features: string[]): number {
  return buildFeedbackAdjuster(db, profileRef)(features);
}

// Digests suppressed by `already_seen` for this profile.
export function suppressedDigests(db: RadarDb, profileRef: string): Set<string> {
  const rows = db.select().from(preferenceFeedback)
    .where(and(eq(preferenceFeedback.profileRef, profileRef), eq(preferenceFeedback.kind, "already_seen"))).all();
  const out = new Set<string>();
  for (const row of rows) {
    for (const f of JSON.parse(row.matchedFeaturesJson) as string[]) {
      if (f.startsWith("evidence:")) out.add(f.slice("evidence:".length));
    }
  }
  return out;
}

export function feedbackForOpportunity(db: RadarDb, profileRef: string, opportunityRef: string): FeedbackReceipt[] {
  return db.select().from(preferenceFeedback)
    .where(and(eq(preferenceFeedback.profileRef, profileRef), eq(preferenceFeedback.opportunityRef, opportunityRef))).all()
    .map((r) => ({
      id: r.id,
      profileRef: r.profileRef,
      opportunityRef: r.opportunityRef,
      kind: r.kind as FeedbackKind,
      matchedFeatures: JSON.parse(r.matchedFeaturesJson) as string[],
      projectRef: r.projectRef,
      createdAt: r.createdAt,
      duplicate: false,
    }));
}

function defaultKey(input: { profileRef: string; opportunityRef: string; kind: string; projectRef?: string }): string {
  return `fb-${createHash("sha256").update(`${input.profileRef}|${input.opportunityRef}|${input.kind}|${input.projectRef ?? ""}`).digest("hex").slice(0, 16)}`;
}
