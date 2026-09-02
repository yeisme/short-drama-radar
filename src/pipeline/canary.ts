import { eq } from "drizzle-orm";
import type { RadarDb } from "../db/client.ts";
import { morningEditionEntries, morningEditions, personalProfileRevisions, preferenceFeedback } from "../db/schema.ts";

export const CANARY_REPORT_SPEC = "radar.canary_report.v1" as const;

export interface CanaryDay {
  date: string;
  editionRef: string;
  status: string;
  entries: number;
  profileRevision: number;
  useful: boolean;
  feedback: Record<string, number>;
  falsePositiveEntries: number;
  unexplainedEntries: number;
  falseOrUnexplainedEntries: number;
}

export interface CanaryReport {
  spec: typeof CANARY_REPORT_SPEC;
  profileRef: string;
  windowDays: number;
  from: string;
  to: string;
  editionDays: number;
  nonEmptyEditionDays: number;
  usefulNonEmptyDays: number;
  usefulnessRate: number;
  emptyDays: number;
  degradedDays: number;
  entriesShown: number;
  falsePositiveEntries: number;
  unexplainedEntries: number;
  falseOrUnexplainedEntries: number;
  falseOrUnexplainedRate: number;
  profileAdjustments: number;
  quantitativePassed: boolean;
  gates: Record<string, { status: "passed" | "failed" | "manual_required"; actual?: number; required?: string }>;
  days: CanaryDay[];
}

export function buildCanaryReport(db: RadarDb, profileRef: string, windowDays = 14, today = new Date()): CanaryReport {
  const days = Math.max(1, Math.floor(windowDays));
  const to = today.toISOString().slice(0, 10);
  const from = new Date(today.getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const latestByDate = new Map<string, typeof morningEditions.$inferSelect>();
  for (const row of db.select().from(morningEditions).where(eq(morningEditions.profileRef, profileRef)).all()) {
    if (row.date < from || row.date > to) continue;
    const prior = latestByDate.get(row.date);
    if (!prior || row.generatedAt > prior.generatedAt) latestByDate.set(row.date, row);
  }

  const entryRows = db.select().from(morningEditionEntries).all();
  const feedbackRows = db.select().from(preferenceFeedback).where(eq(preferenceFeedback.profileRef, profileRef)).all();
  const feedbackByOpportunity = new Map<string, Set<string>>();
  for (const row of feedbackRows) {
    const kinds = feedbackByOpportunity.get(row.opportunityRef) ?? new Set<string>();
    kinds.add(row.kind);
    feedbackByOpportunity.set(row.opportunityRef, kinds);
  }

  const canaryDays = [...latestByDate.values()].sort((a, b) => a.date.localeCompare(b.date)).map((edition): CanaryDay => {
    const entries = entryRows.filter((entry) => entry.editionRef === edition.editionRef);
    const feedback: Record<string, number> = {};
    let falsePositiveEntries = 0;
    let unexplainedEntries = 0;
    let falseOrUnexplainedEntries = 0;
    let useful = false;
    for (const entry of entries) {
      const kinds = feedbackByOpportunity.get(entry.opportunityRef) ?? new Set<string>();
      for (const kind of kinds) feedback[kind] = (feedback[kind] ?? 0) + 1;
      if (kinds.has("saved") || kinds.has("used")) useful = true;
      const falsePositive = kinds.has("not_relevant");
      const unexplained = (JSON.parse(entry.reasonCodesJson) as string[]).length === 0;
      if (falsePositive) falsePositiveEntries++;
      if (unexplained) unexplainedEntries++;
      if (falsePositive || unexplained) falseOrUnexplainedEntries++;
    }
    return {
      date: edition.date,
      editionRef: edition.editionRef,
      status: edition.status,
      entries: entries.length,
      profileRevision: edition.profileRevision,
      useful,
      feedback,
      falsePositiveEntries,
      unexplainedEntries,
      falseOrUnexplainedEntries,
    };
  });

  const nonEmpty = canaryDays.filter((day) => day.entries > 0);
  const useful = nonEmpty.filter((day) => day.useful).length;
  const entriesShown = canaryDays.reduce((sum, day) => sum + day.entries, 0);
  const falsePositiveEntries = canaryDays.reduce((sum, day) => sum + day.falsePositiveEntries, 0);
  const unexplainedEntries = canaryDays.reduce((sum, day) => sum + day.unexplainedEntries, 0);
  const falseOrUnexplainedEntries = canaryDays.reduce((sum, day) => sum + day.falseOrUnexplainedEntries, 0);
  const usefulnessRate = nonEmpty.length === 0 ? 0 : round2(useful / nonEmpty.length);
  const falseOrUnexplainedRate = entriesShown === 0 ? 0 : round2(falseOrUnexplainedEntries / entriesShown);
  const profileAdjustments = db.select().from(personalProfileRevisions)
    .where(eq(personalProfileRevisions.profileRef, profileRef)).all()
    .filter((row) => row.revision > 1 && row.createdAt.slice(0, 10) >= from && row.createdAt.slice(0, 10) <= to).length;
  const quantitativePassed = canaryDays.length >= 10 && nonEmpty.length > 0 && usefulnessRate >= 0.6 && falseOrUnexplainedRate <= 0.25;

  return {
    spec: CANARY_REPORT_SPEC,
    profileRef,
    windowDays: days,
    from,
    to,
    editionDays: canaryDays.length,
    nonEmptyEditionDays: nonEmpty.length,
    usefulNonEmptyDays: useful,
    usefulnessRate,
    emptyDays: canaryDays.filter((day) => day.entries === 0).length,
    degradedDays: canaryDays.filter((day) => day.status === "degraded").length,
    entriesShown,
    falsePositiveEntries,
    unexplainedEntries,
    falseOrUnexplainedEntries,
    falseOrUnexplainedRate,
    profileAdjustments,
    quantitativePassed,
    gates: {
      reviewable_editions: { status: canaryDays.length >= 10 ? "passed" : "failed", actual: canaryDays.length, required: ">=10 days" },
      usefulness: { status: nonEmpty.length > 0 && usefulnessRate >= 0.6 ? "passed" : "failed", actual: usefulnessRate, required: ">=0.60 of non-empty days with saved|used" },
      false_or_unexplained: { status: entriesShown > 0 && falseOrUnexplainedRate <= 0.25 ? "passed" : "failed", actual: falseOrUnexplainedRate, required: "<=0.25 of shown entries" },
      hermes_brief_and_memory_conflict: { status: "manual_required" },
      secret_leak_review: { status: "manual_required" },
      external_replay_audit: { status: "manual_required" },
    },
    days: canaryDays,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
