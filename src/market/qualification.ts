import { and, eq, gte, lt, inArray } from "drizzle-orm";
import type { RadarDb } from "../db/client.ts";
import { marketBatches, marketEvidence, marketSamplingChecks, marketQualificationRecords } from "../db/schema.ts";
import { marketDigest, MarketStoreError, sourceByRef } from "./repository.ts";
import { listSources } from "./sources.ts";
import { samplingPlan } from "./sampling.ts";

export interface QualificationRecord {
  spec: "radar.market_qualification_record.v1"; record_ref: string; digest: string;
  rule_version: "market-qualification.v1"; report: ReturnType<typeof qualificationReport>;
}
export function recordQualification(db: RadarDb, sourceRef: string, revision: number, now = new Date()) {
  return db.transaction(tx => {
    const source = sourceByRef(tx, sourceRef);
    if (!source || source.revision !== revision) throw new MarketStoreError("state_conflict", "Read the current source revision before recording qualification.");
    const report = qualificationReport(tx, sourceRef, now);
    const content = { spec: "radar.market_qualification_record.v1" as const, rule_version: "market-qualification.v1" as const, report };
    const digest = marketDigest(content), ref = "qualification-" + digest.slice(7, 39);
    const previous = tx.select().from(marketQualificationRecords).where(eq(marketQualificationRecords.ref, ref)).get();
    if (previous) return { record: previous.payload, reused: true };
    const record: QualificationRecord = { ...content, record_ref: ref, digest };
    tx.insert(marketQualificationRecords).values({ ref, sourceRef, payload: record }).run();
    return { record, reused: false };
  }, { behavior: "immediate" });
}
export function qualificationRecord(db: RadarDb, ref: string) {
  const record = db.select().from(marketQualificationRecords).where(eq(marketQualificationRecords.ref, ref)).get()?.payload;
  if (!record) throw new MarketStoreError("qualification_not_found", "Qualification record does not exist.");
  return record;
}

export function qualificationReport(db: RadarDb, sourceRef: string, now = new Date()) {
  if (!Number.isFinite(now.getTime())) throw new MarketStoreError("time_invalid", "Qualification time must be valid.");
  const source = sourceByRef(db, sourceRef);
  if (!source) throw new MarketStoreError("source_not_found", "Source is not registered.");
  // Qualify seven COMPLETE UTC days. Today's partial observations are used
  // for freshness but never turn a partial day into a completed daily plan.
  const cutoff = new Date(now.toISOString().slice(0, 10) + "T00:00:00.000Z");
  const from = new Date(cutoff.getTime() - 7 * 86400000).toISOString();
  const plan = samplingPlan(db, sourceRef, source.revision);
  const rows = db.select().from(marketBatches).where(and(
    eq(marketBatches.sourceRef, sourceRef), eq(marketBatches.sourceRevision, source.revision),
    gte(marketBatches.observedAt, from), lt(marketBatches.observedAt, now.toISOString()),
  )).orderBy(marketBatches.observedAt).all();
  const live = rows.filter(row => row.origin === "live");
  const checks = live.length ? db.select().from(marketSamplingChecks).where(inArray(marketSamplingChecks.batchRef, live.map(row => row.ref))).all() : [];
  const validSchedule = new Map<string, Set<string>>();
  for (const row of live) {
    const check = checks.find(c => c.batchRef === row.ref)?.payload;
    if (!check || check.checked_at > now.toISOString() || check.completeness !== "complete" ||
      !check.stable_ids || !check.metric_contract_valid || !row.observationRefs.length ||
      Date.parse(row.observedAt) - Date.parse(check.scheduled_at) > 3600_000 ||
      check.scheduled_at.slice(0, 10) !== row.observedAt.slice(0, 10)) continue;
    const evidence = db.select().from(marketEvidence).where(eq(marketEvidence.ref, check.failure_sample_ref)).get();
    if (!evidence || evidence.payload.origin === "fixture") continue;
    const date = row.observedAt.slice(0, 10), slots = validSchedule.get(date) ?? new Set<string>();
    slots.add(check.scheduled_at.slice(11));
    validSchedule.set(date, slots);
  }
  const perDay = new Map<string, Set<number>>();
  for (const row of live) {
    if (row.observedAt >= cutoff.toISOString()) continue;
    const date = row.observedAt.slice(0, 10);
    const times = perDay.get(date) ?? new Set<number>();
    times.add(Date.parse(row.observedAt));
    perDay.set(date, times);
  }
  const days = Array.from({ length: 7 }, (_, i) => {
    const date = new Date(Date.parse(from) + i * 86400000).toISOString().slice(0, 10);
    const times = [...(perDay.get(date) ?? [])].sort((a, b) => a - b);
    return { date, observations: times.length,
      two_spaced_observations: times.length >= 2 && times[times.length - 1] - times[0] >= 12 * 3600000 };
  });
  const identityRows = source.official_identity_evidence.length ? db.select().from(marketEvidence)
    .where(inArray(marketEvidence.ref, source.official_identity_evidence)).all() : [];
  const identityVerified = source.official_identity_evidence.length > 0 &&
    source.official_identity_evidence.every(ref => identityRows.some(row => row.ref === ref &&
      row.sourceRef === sourceRef && row.payload.origin !== "fixture" && Date.parse(row.observedAt) <= now.getTime()));
  const latest = live.at(-1);
  const freshness = !latest ? "unavailable" : source.freshness_budget === null ? "freshness_unknown"
    : (now.getTime() - Date.parse(latest.observedAt)) / 1000 <= source.freshness_budget ? "fresh" : "stale";
  const reasons: string[] = [];
  if (!identityVerified) reasons.push("identity_evidence_missing");
  if (!rows.some(row => row.observationRefs.length > 0 && row.origin !== "fixture")) reasons.push("non_fixture_sample_missing");
  if (!days.every(day => day.two_spaced_observations)) reasons.push("seven_complete_live_days_missing");
  const commonSlots = [...(validSchedule.get(days[0].date) ?? [])].filter(slot => days.every(day => validSchedule.get(day.date)?.has(slot))).sort();
  const planRegistered = !!plan && plan.registered_at < from && plan.sampling_scope === source.sampling_scope;
  const scheduleVerified = planRegistered && plan.utc_slots.every(slot => commonSlots.includes(slot + ":00.000Z"));
  if (!planRegistered) reasons.push("sampling_plan_not_preregistered");
  if (!scheduleVerified) reasons.push("sampling_schedule_verification_required");
  if (!["sample_verified", "qualified"].includes(source.readiness)) reasons.push("sample_review_required");
  if (source.readiness === "blocked") reasons.push("source_blocked");
  if (source.role === "industry") reasons.push("background_source_not_daily_trend");
  return {
    spec: "radar.market_qualification.v1", source_ref: sourceRef, source_revision: source.revision,
    as_of: now.toISOString(), configured_readiness: source.readiness,
    qualified: reasons.length === 0, health: freshness, identity_verified: identityVerified,
    sampling_schedule_verified: scheduleVerified, fixed_utc_slots: commonSlots,
    sampling_plan: plan, sampling_plan_preregistered: planRegistered,
    window: { start: from, end: cutoff.toISOString() }, days,
    sample_batches: { live: live.length, manual: rows.filter(row => row.origin === "manual").length, fixture: rows.filter(row => row.origin === "fixture").length },
    latest_live_observation: latest?.observedAt ?? null, reasons,
    limitations: source.limitations,
  };
}

export function sourceGaps(db: RadarDb, now = new Date()) {
  const sources = listSources(db).map(source => ({
    platform: source.platform, declared_markets: source.market_scope,
    ...qualificationReport(db, source.source_ref, now),
  }));
  const targets = ["CN", "US", "MX", "BR", "ID", "IN", "TH", "PH", "JP", "KR", "GB", "DE", "FR"];
  return {
    spec: "radar.market_source_gaps.v1", as_of: now.toISOString(), sources,
    markets: targets.map(market => ({
      market,
      declared_sources: sources.filter(source => source.declared_markets.includes(market as Uppercase<string>)).map(source => source.source_ref),
      status: "coverage_unverified",
      reason: "Source declarations and App availability do not prove audience or complete market coverage.",
    })),
  };
}
