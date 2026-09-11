import { and, desc, eq, gte, lt } from "drizzle-orm";
import type { RadarDb } from "../db/client.ts";
import { marketBatches, marketEvidence, marketObservations, marketSamplingChecks, marketSignals } from "../db/schema.ts";
import { isMarketInstant, type MarketObservation, type WorkMapping } from "./domain.ts";
import { marketDigest, MarketStoreError, sourceByRef } from "./repository.ts";
import { compareMetric, type ComparisonResult, type ComparisonInput } from "./comparison.ts";
import { MARKET_MAPPING_VERSION } from "./classification.ts";
import { assertMarketContentReadable } from "./policy.ts";
import { reviewWorkMapping, workMapping, workSubjectRef } from "./identity.ts";

export const MARKET_ANALYSIS_VERSION = "market-analysis.v1";
// Versioned evidence gates for aggregate claims (design §4). Changing the
// ten-work minimum or the frame rules requires a new version so historical
// confirmations stay attributable to the rule that produced them.
export const MARKET_CLAIM_GATES_VERSION = "market-claim-gates.v1";
export const TOPIC_MIX_MIN_WORKS = 10;
// Aggregate claims cite at most this many observations so a full directory
// snapshot never produces an unbounded signal payload.
const AGGREGATE_REF_LIMIT = 10;

export interface MarketSignal {
  spec: "radar.market_signal.v1";
  signal_ref: string;
  revision: number;
  claim_kind: "newly_observed" | "listing_changed" | "rank_changed" | "metric_changed" | "placement_changed"
    | "topic_mix_changed" | "cross_market_observed" | "correction";
  assertion_level: "observed" | "corroborated" | "confirmed";
  lifecycle: "active" | "retracted" | "inconclusive" | "cooled";
  corrects_revision?: number;
  subject_ref: string;
  source_ref: string;
  market: string;
  title: string;
  topics: string[];
  observed_at: string;
  observation_refs: string[];
  evidence_refs: string[];
  comparison: ComparisonResult | null;
  listing?: {
    added: Array<{ source_item_id: string; title: string }>;
    removed: Array<{ source_item_id: string; title: string }>;
    snapshot_before: string;
    snapshot_after: string;
    removal_verified: boolean;
  };
  topic_mix?: {
    topic: string;
    before: { works: number; topic_works: number; share: number };
    after: { works: number; topic_works: number; share: number };
    snapshot_before: string;
    snapshot_after: string;
  };
  cross_market?: {
    topic: string;
    markets: Array<{ market: string; source_refs: string[]; publisher_groups: string[];
      observation_refs: string[]; market_evidence_refs: string[] }>;
  };
  independent_evidence_groups?: number;
  limitations: string[];
  analysis_version: string;
  mapping_version: string;
  origin: MarketObservation["origin"];
}

export const MARKET_SIGNAL_ORDER_VERSION = "market-signal-order.v1";
const ASSERTION_ORDER: Record<MarketSignal["assertion_level"], number> = { confirmed: 0, corroborated: 1, observed: 2 };
const SOURCE_ROLE_ORDER: Record<"catalog" | "discussion" | "industry", number> = { catalog: 0, discussion: 1, industry: 2 };
export type MarketSourceRole = "catalog" | "discussion" | "industry";

// Design §4 deterministic order: corrections first, confirmed claims, source
// priority, independent evidence groups, latest observation, stable ref. The
// rule is versioned so consumers can explain why an entry ranks where it does.
export function compareMarketSignalOrder(
  a: MarketSignal, b: MarketSignal,
  sourceRole: (ref: string) => MarketSourceRole | undefined = () => undefined,
): number {
  const step = (value: number) => (value < 0 ? -1 : value > 0 ? 1 : 0);
  let order = step(Number(b.claim_kind === "correction") - Number(a.claim_kind === "correction"));
  if (order) return order;
  order = step(ASSERTION_ORDER[a.assertion_level] - ASSERTION_ORDER[b.assertion_level]);
  if (order) return order;
  order = step(SOURCE_ROLE_ORDER[sourceRole(a.source_ref) ?? "industry"] - SOURCE_ROLE_ORDER[sourceRole(b.source_ref) ?? "industry"]);
  if (order) return order;
  order = step((b.independent_evidence_groups ?? 1) - (a.independent_evidence_groups ?? 1));
  if (order) return order;
  order = step(b.observed_at.localeCompare(a.observed_at));
  if (order) return order;
  return a.signal_ref.localeCompare(b.signal_ref);
}

export function signalByRef(db: RadarDb, ref: string, revision?: number): MarketSignal | null {
  return db.select().from(marketSignals).where(revision === undefined ? eq(marketSignals.ref, ref)
    : and(eq(marketSignals.ref, ref), eq(marketSignals.revision, revision)))
    .orderBy(desc(marketSignals.revision)).limit(1).get()?.payload ?? null;
}

function persistSignal(db: RadarDb, value: Omit<MarketSignal, "revision">): { signal: MarketSignal; reused: boolean } {
  const fingerprint = marketDigest(value);
  const old = db.select().from(marketSignals).where(and(eq(marketSignals.ref, value.signal_ref), eq(marketSignals.fingerprint, fingerprint))).get();
  if (old) return { signal: old.payload, reused: true };
  const head = signalByRef(db, value.signal_ref);
  const signal = { ...value, revision: (head?.revision ?? 0) + 1 };
  db.insert(marketSignals).values({
    ref: signal.signal_ref, revision: signal.revision, sourceRef: signal.source_ref,
    observedAt: signal.observed_at, fingerprint, payload: signal,
  }).run();
  return { signal, reused: false };
}

export function correctSignal(db: RadarDb, input: {
  ref: string; expected_revision: number; reason: string; evidence_refs: string[];
  outcome: "retracted" | "inconclusive"; corrected_at: string;
}) {
  if (!isMarketInstant(input.corrected_at) || !Number.isSafeInteger(input.expected_revision) || input.expected_revision < 1 ||
    !["retracted", "inconclusive"].includes(input.outcome) ||
    typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 500 ||
    !Array.isArray(input.evidence_refs) || !input.evidence_refs.length || input.evidence_refs.length > 10) {
    throw new MarketStoreError("correction_invalid", "Provide a revision, bounded reason, outcome, evidence refs and UTC correction time.");
  }
  return db.transaction(tx => {
    const old = signalByRef(tx, input.ref, input.expected_revision);
    const head = signalByRef(tx, input.ref);
    if (!old || !head) throw new MarketStoreError("signal_not_found", "Signal revision not found.");
    const evidence = [...new Set(input.evidence_refs)].sort();
    for (const ref of evidence) {
      const row = tx.select().from(marketEvidence).where(eq(marketEvidence.ref, ref)).get();
      if (!row || Date.parse(row.observedAt) > Date.parse(input.corrected_at)) {
        throw new MarketStoreError("evidence_not_found", "Correction evidence must exist at the correction time.");
      }
    }
    if (Date.parse(input.corrected_at) < Date.parse(old.observed_at)) throw new MarketStoreError("correction_invalid", "Correction cannot precede the original observation.");
    const { revision: _revision, ...prior } = old;
    const value: Omit<MarketSignal, "revision"> = {
      ...prior, claim_kind: "correction", lifecycle: input.outcome, assertion_level: "observed",
      corrects_revision: old.revision, observed_at: new Date(input.corrected_at).toISOString(),
      comparison: null, evidence_refs: [...new Set([...old.evidence_refs, ...evidence])],
      limitations: [input.reason.trim(), "Explicit owner correction; consult the original revision and linked evidence."],
    };
    const fingerprint = marketDigest(value);
    const existing = tx.select().from(marketSignals).where(and(eq(marketSignals.ref, input.ref), eq(marketSignals.fingerprint, fingerprint))).get();
    if (existing) return { signal: existing.payload, reused: true };
    if (head.revision !== input.expected_revision) throw new MarketStoreError("state_conflict", "Signal changed; inspect the latest revision before correcting.");
    return persistSignal(tx, value);
  }, { behavior: "immediate" });
}

export function restoreSignal(db: RadarDb, input: {
  ref: string; expected_revision: number; observation_ref: string; reason: string; reviewed_at: string;
}, now = new Date()) {
  if (!input || !Number.isSafeInteger(input.expected_revision) || input.expected_revision < 1 ||
    typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 500 ||
    !isMarketInstant(input.reviewed_at) || Date.parse(input.reviewed_at) > now.getTime()) {
    throw new MarketStoreError("review_invalid", "Provide a correction revision, new observation, bounded reason and completed review time.");
  }
  return db.transaction(tx => {
    const old = signalByRef(tx, input.ref, input.expected_revision);
    if (!old || old.claim_kind !== "correction") throw new MarketStoreError("review_invalid", "Select an explicit correction revision to review.");
    assertMarketContentReadable(tx, old.topics);
    const o = tx.select().from(marketObservations).where(eq(marketObservations.ref, input.observation_ref)).get()?.payload;
    if (!o || o.source_ref !== old.source_ref || o.market !== old.market || o.origin !== old.origin ||
      workSubjectRef(o.source_ref, o.source_item_id) !== old.subject_ref ||
      Date.parse(o.observed_at) <= Date.parse(old.observed_at) || Date.parse(o.observed_at) > Date.parse(input.reviewed_at)) {
      throw new MarketStoreError("review_evidence_invalid", "Use a newer observation for the same source, subject, market and origin, available by review time.");
    }
    assertMarketContentReadable(tx, o.topics);
    const original = tx.select().from(marketSignals).where(eq(marketSignals.ref, input.ref))
      .orderBy(desc(marketSignals.revision)).all().find(row => row.revision < old.revision && row.payload.claim_kind !== "correction")?.payload;
    if (!original) throw new MarketStoreError("review_invalid", "Original claim is unavailable.");
    const history = tx.select().from(marketObservations).where(and(eq(marketObservations.sourceRef, o.source_ref),
      eq(marketObservations.itemId, o.source_item_id), eq(marketObservations.market, o.market),
      eq(marketObservations.origin, o.origin), lt(marketObservations.observedAt, o.observed_at)))
      .orderBy(desc(marketObservations.observedAt)).limit(2).all().map(row => row.payload);
    const context = (observation: MarketObservation): ComparisonInput => {
      const source = sourceByRef(tx, observation.source_ref, observation.source_revision);
      if (!source) throw new MarketStoreError("source_not_found", "Review source revision is unavailable.");
      return { observation, source, mappingVersion: MARKET_MAPPING_VERSION, windowRule: "equal-adjacent-observed-intervals.v1" };
    };
    let comparison: ComparisonResult | null = null;
    let refs = [o.observation_ref];
    if (original.claim_kind !== "newly_observed") {
      for (const fact of o.facts) {
        const result = compareMetric(history[0] ? context(history[0]) : null, context(o), fact.name,
          fact.basis === "cumulative" && history[1] ? context(history[1]) : undefined);
        if (result.comparable && result.change !== 0 && original.comparison?.comparable &&
          result.comparison_key === original.comparison.comparison_key) {
          comparison = result;
          refs = [...history.slice(0, fact.basis === "cumulative" ? 2 : 1).reverse().map(h => h.observation_ref), o.observation_ref];
          break;
        }
      }
      if (!comparison) throw new MarketStoreError("review_evidence_invalid", "New evidence does not support the original metric comparison contract.");
    }
    for (const observation of history.filter(h => refs.includes(h.observation_ref))) assertMarketContentReadable(tx, observation.topics);
    const { revision: _revision, ...prior } = original;
    const value: Omit<MarketSignal, "revision"> = { ...prior, title: o.title, topics: o.topics,
      lifecycle: "active", corrects_revision: old.revision, observed_at: new Date(input.reviewed_at).toISOString(),
      comparison, observation_refs: refs, evidence_refs: comparison?.comparable ? comparison.evidence_refs : o.evidence_refs,
      limitations: [input.reason.trim(), "Explicit owner evidence review restores this claim; prior correction remains in history.",
        ...(comparison?.comparable ? comparison.limitations : ["Observed in the source sample again; not a premiere or popularity claim."])],
    };
    const priorReview = tx.select().from(marketSignals).where(and(eq(marketSignals.ref, input.ref),
      eq(marketSignals.fingerprint, marketDigest(value)))).get();
    if (priorReview) return { signal: priorReview.payload, reused: true };
    if (signalByRef(tx, input.ref)?.revision !== old.revision) throw new MarketStoreError("state_conflict", "Signal changed; inspect its current revision before review.");
    return persistSignal(tx, value);
  }, { behavior: "immediate" });
}

// Owner identity review plus signal regeneration. Verifying a candidate for
// the first time establishes identity and revises nothing; moving a verified
// canonical ref to another work changes what earlier claims were about, so
// every affected signal head gets a correction revision in the same
// transaction as the mapping write (design §3: mapping changes must version
// affected signals without rewriting history).
export function reviewWorkIdentity(db: RadarDb, input: {
  work: string; expected_revision: number; canonical_work_ref: string; evidence_refs: string[];
}, now = new Date()) {
  if (!Number.isFinite(now.getTime())) throw new MarketStoreError("review_invalid", "Identity review requires a valid review time.");
  return db.transaction(tx => {
    const prior = workMapping(tx, input.work);
    const review = reviewWorkMapping(tx, input);
    const identityChanged = prior?.mapping_status === "verified" && prior.canonical_work_ref !== null &&
      review.mapping.canonical_work_ref !== prior.canonical_work_ref;
    const signalRevisions = identityChanged ? reviseSignalsForIdentityChange(tx, prior!, review.mapping, now) : [];
    return { mapping: review.mapping, reused: review.reused, identity_changed: identityChanged, signal_revisions: signalRevisions };
  }, { behavior: "immediate" });
}

function reviseSignalsForIdentityChange(tx: RadarDb, prior: WorkMapping, mapping: WorkMapping, now: Date) {
  const heads = new Map<string, MarketSignal>();
  for (const row of tx.select().from(marketSignals).orderBy(marketSignals.ref, desc(marketSignals.revision)).all()) {
    if (!heads.has(row.ref)) heads.set(row.ref, row.payload);
  }
  const revised: Array<{ ref: string; revision: number }> = [];
  for (const head of heads.values()) {
    if (head.subject_ref !== mapping.platform_work_ref) continue;
    const { revision: _revision, ...rest } = head;
    const value: Omit<MarketSignal, "revision"> = {
      ...rest, claim_kind: "correction", lifecycle: "retracted", assertion_level: "observed",
      corrects_revision: head.revision, observed_at: now.toISOString(), comparison: null,
      evidence_refs: [...new Set([...head.evidence_refs, ...mapping.supporting_evidence_refs])].sort(),
      limitations: [
        `Verified identity mapping moved canonical work ${prior.canonical_work_ref} to ${mapping.canonical_work_ref} at mapping revision ${mapping.mapping_revision}; the prior subject interpretation no longer holds.`,
        "Explicit identity correction; the original revision and mapping history remain reviewable.",
      ],
    };
    revised.push({ ref: head.signal_ref, revision: persistSignal(tx, value).signal.revision });
  }
  return revised;
}

export function analyzeMarket(db: RadarDb, start: string, end: string) {
  if (!isMarketInstant(start) || !isMarketInstant(end) || Date.parse(start) >= Date.parse(end)) {
    throw new MarketStoreError("window_invalid", "Use an increasing UTC analysis window.");
  }
  const from = new Date(start).toISOString(), until = new Date(end).toISOString();
  return db.transaction(tx => {
    const rows = tx.select().from(marketObservations).where(and(gte(marketObservations.observedAt, from), lt(marketObservations.observedAt, until)))
      .orderBy(marketObservations.observedAt, marketObservations.ref).all();
    const results: Array<{ signal: MarketSignal; reused: boolean }> = [];
    const skipped: Array<{ observation_ref: string; metric: string; reasons: string[] }> = [];
    const persistAnalyzed = (value: Omit<MarketSignal, "revision">, observationRef: string, metric: string) => {
      const head = signalByRef(tx, value.signal_ref);
      // Automatic analysis cannot reverse an explicit owner correction.
      // Observations remain stored for a subsequent explicit evidence review.
      if (head?.claim_kind === "correction") {
        skipped.push({ observation_ref: observationRef, metric, reasons: ["correction_review_required"] });
        return;
      }
      if (head && Date.parse(value.observed_at) < Date.parse(head.observed_at)) {
        skipped.push({ observation_ref: observationRef, metric, reasons: ["historical_signal_revision_preserved"] });
        return;
      }
      results.push(persistSignal(tx, value));
    };
    const context = (o: MarketObservation): ComparisonInput => {
      const source = sourceByRef(tx, o.source_ref, o.source_revision);
      if (!source) throw new MarketStoreError("source_not_found", "Observation references an unavailable source revision.");
      return { source, observation: o, mappingVersion: MARKET_MAPPING_VERSION, windowRule: "equal-adjacent-observed-intervals.v1" };
    };
    // Shared payload fields for snapshot-level claims; per-claim fields are
    // filled by the listing, topic-mix and cross-market blocks below.
    const frameBase = (frame: { source: ReturnType<typeof sourceByRef>; market: MarketObservation["market"]; origin: MarketObservation["origin"] }, observedAt: string) => ({
      spec: "radar.market_signal.v1" as const, subject_ref: "",
      source_ref: frame.source!.source_ref, market: frame.market,
      title: "", topics: [], observed_at: observedAt, lifecycle: "active" as const,
      analysis_version: MARKET_ANALYSIS_VERSION, mapping_version: MARKET_MAPPING_VERSION,
      origin: frame.origin, independent_evidence_groups: 1,
    });
    for (const row of rows) {
      const o = row.payload;
      const history = tx.select().from(marketObservations).where(and(
        eq(marketObservations.sourceRef, row.sourceRef), eq(marketObservations.itemId, row.itemId),
        eq(marketObservations.market, row.market), eq(marketObservations.origin, row.origin),
        lt(marketObservations.observedAt, row.observedAt),
      )).orderBy(desc(marketObservations.observedAt)).limit(2).all().map(r => r.payload);
      const subject = workSubjectRef(o.source_ref, o.source_item_id);
      const base = {
        spec: "radar.market_signal.v1" as const, subject_ref: subject, source_ref: o.source_ref,
        market: o.market, title: o.title, topics: o.topics, observed_at: o.observed_at,
        lifecycle: "active" as const, analysis_version: MARKET_ANALYSIS_VERSION,
        mapping_version: MARKET_MAPPING_VERSION, origin: o.origin, independent_evidence_groups: 1,
      };
      if (!history.length) {
        persistAnalyzed({
          ...base, signal_ref: "signal-" + marketDigest([subject, o.market, o.origin, "new"]).slice(7, 39),
          claim_kind: "newly_observed", assertion_level: "observed", comparison: null,
          observation_refs: [o.observation_ref], evidence_refs: o.evidence_refs,
          limitations: ["First observed in this source sample; not a premiere or popularity claim."],
        }, o.observation_ref, "newly_observed");
      }
      for (const fact of o.facts) {
        const result = compareMetric(history[0] ? context(history[0]) : null, context(o), fact.name,
          fact.basis === "cumulative" && history[1] ? context(history[1]) : undefined);
        if (!result.comparable) {
          skipped.push({ observation_ref: o.observation_ref, metric: fact.name, reasons: result.reasons });
          continue;
        }
        if (result.change === 0) continue;
        persistAnalyzed({
          ...base, signal_ref: "signal-" + marketDigest([subject, o.market, o.origin, fact.name, result.comparison_key]).slice(7, 39),
          claim_kind: result.claim_kind, assertion_level: "confirmed", comparison: result,
          observation_refs: [...history.slice(0, fact.basis === "cumulative" ? 2 : 1).reverse().map(h => h.observation_ref), o.observation_ref],
          evidence_refs: result.evidence_refs, limitations: result.limitations,
        }, o.observation_ref, fact.name);
      }
    }
    // Aggregate claims operate on snapshot sets, not single observations.
    // A frame groups observations that share source revision, market and
    // origin: differing revisions or sampling scopes never mix, so a rules
    // change rebuilds the baseline instead of fabricating a diff.
    const frames = new Map<string, { source: ReturnType<typeof sourceByRef>; market: MarketObservation["market"]; origin: MarketObservation["origin"]; snapshots: Array<{ at: string; items: Map<string, MarketObservation> }> }>();
    for (const row of rows) {
      const o = row.payload;
      const key = [o.source_ref, o.source_revision, o.market, o.origin].join("|");
      let frame = frames.get(key);
      if (!frame) {
        const source = sourceByRef(tx, o.source_ref, o.source_revision);
        if (!source) throw new MarketStoreError("source_not_found", "Observation references an unavailable source revision.");
        frame = { source, market: o.market, origin: o.origin, snapshots: [] };
        frames.set(key, frame);
      }
      let snapshot = frame.snapshots.find(s => s.at === o.observed_at);
      if (!snapshot) { snapshot = { at: o.observed_at, items: new Map() }; frame.snapshots.push(snapshot); }
      snapshot.items.set(o.source_item_id, o);
    }
    // Completeness attestations come from owner sampling checks (1.8); an
    // unknown or partial result keeps removals and share claims unconfirmed.
    const completenessAt = (sourceRef: string, at: string, origin: MarketObservation["origin"]): "complete" | "partial" | "unknown" => {
      const batches = tx.select({ ref: marketBatches.ref }).from(marketBatches).where(and(
        eq(marketBatches.sourceRef, sourceRef), eq(marketBatches.observedAt, at), eq(marketBatches.origin, origin))).all();
      const checks = batches.flatMap(batch =>
        tx.select().from(marketSamplingChecks).where(eq(marketSamplingChecks.batchRef, batch.ref)).all().map(row => row.payload.completeness));
      if (checks.includes("partial")) return "partial";
      return checks.includes("complete") ? "complete" : "unknown";
    };
    const topicCounts = (items: Map<string, MarketObservation>) => {
      const counts = new Map<string, number>();
      for (const o of items.values()) for (const topic of o.topics) counts.set(topic, (counts.get(topic) ?? 0) + 1);
      return counts;
    };
    const shareOf = (count: number, works: number) => Math.round((count / works) * 10000) / 10000;
    for (const frame of frames.values()) {
      frame.snapshots.sort((a, b) => a.at.localeCompare(b.at));
      // The latest snapshot strictly before the window is the comparison
      // baseline, so a daily window still reports directory movement.
      const priorAt = tx.select({ at: marketObservations.observedAt }).from(marketObservations).where(and(
        eq(marketObservations.sourceRef, frame.source!.source_ref),
        eq(marketObservations.sourceRevision, frame.source!.revision),
        eq(marketObservations.market, frame.market), eq(marketObservations.origin, frame.origin),
        lt(marketObservations.observedAt, from),
      )).orderBy(desc(marketObservations.observedAt)).limit(1).get()?.at;
      if (priorAt && !frame.snapshots.some(s => s.at === priorAt)) {
        const items = new Map(tx.select().from(marketObservations).where(and(
          eq(marketObservations.sourceRef, frame.source!.source_ref),
          eq(marketObservations.sourceRevision, frame.source!.revision),
          eq(marketObservations.market, frame.market), eq(marketObservations.origin, frame.origin),
          eq(marketObservations.observedAt, priorAt),
        )).all().map(row => [row.payload.source_item_id, row.payload]));
        frame.snapshots.unshift({ at: priorAt, items });
      }
      for (let i = 1; i < frame.snapshots.length; i++) {
        const before = frame.snapshots[i - 1], after = frame.snapshots[i];
        const completeness = completenessAt(frame.source!.source_ref, after.at, frame.origin);
        const firstAfterRef = after.items.values().next().value!.observation_ref;
        const added = [...after.items.keys()].filter(id => !before.items.has(id)).sort();
        const removed = [...before.items.keys()].filter(id => !after.items.has(id)).sort();
        if (added.length || removed.length) {
          // Additions are directly evidenced by the later snapshot; removals
          // additionally need an attested-complete frame before confirmation
          // because an incomplete sample would fabricate delisting claims.
          const removalVerified = completeness === "complete";
          const involved = [...added.map(id => after.items.get(id)!), ...removed.map(id => before.items.get(id)!)]
            .sort((a, b) => a.observation_ref.localeCompare(b.observation_ref));
          const cited = involved.slice(0, AGGREGATE_REF_LIMIT);
          const subject = "listing-" + marketDigest([frame.source!.source_ref, frame.source!.revision, frame.market, frame.origin, frame.source!.sampling_scope]).slice(7, 31);
          persistAnalyzed({
            ...frameBase(frame, after.at),
            signal_ref: "signal-" + marketDigest([subject, frame.market, frame.origin, "listing", frame.source!.revision]).slice(7, 39),
            claim_kind: "listing_changed", comparison: null,
            assertion_level: removed.length === 0 || removalVerified ? "confirmed" : "observed",
            subject_ref: subject,
            title: frame.source!.source_ref + " directory sample (" + frame.market + ")",
            topics: [...new Set(cited.flatMap(o => o.topics))].sort(),
            observation_refs: cited.map(o => o.observation_ref),
            evidence_refs: [...new Set(cited.flatMap(o => o.evidence_refs))].sort(),
            listing: {
              added: added.map(id => ({ source_item_id: id, title: after.items.get(id)!.title })),
              removed: removed.map(id => ({ source_item_id: id, title: before.items.get(id)!.title })),
              snapshot_before: before.at, snapshot_after: after.at, removal_verified: removalVerified,
            },
            limitations: [
              "Directory sample comparison between two snapshots of one sampling scope; this is not audience demand or popularity.",
              ...(removed.length ? [removalVerified
                ? "An attested-complete later snapshot no longer lists these works in the sampled directory; absence is still not platform delisting."
                : completeness === "partial"
                  ? "A recorded sampling check marks the later snapshot partial, so removals stay unconfirmed."
                  : "The later snapshot has no completeness attestation, so removals stay unconfirmed and must not be read as delisting."] : []),
              ...(involved.length > AGGREGATE_REF_LIMIT
                ? ["Directory diff cites the first " + AGGREGATE_REF_LIMIT + " of " + involved.length + " involved observations."] : []),
            ],
          }, firstAfterRef, "listing");
        }
        const worksBefore = before.items.size, worksAfter = after.items.size;
        const beforeCounts = topicCounts(before.items), afterCounts = topicCounts(after.items);
        const meetsMinimum = worksBefore >= TOPIC_MIX_MIN_WORKS && worksAfter >= TOPIC_MIX_MIN_WORKS;
        const frameComplete = completeness === "complete";
        const afterObservations = [...after.items.values()].sort((a, b) => a.observation_ref.localeCompare(b.observation_ref));
        const citedAfter = afterObservations.slice(0, AGGREGATE_REF_LIMIT);
        for (const topic of [...new Set([...beforeCounts.keys(), ...afterCounts.keys()])].sort()) {
          const topicBefore = beforeCounts.get(topic) ?? 0, topicAfter = afterCounts.get(topic) ?? 0;
          const shareBefore = shareOf(topicBefore, worksBefore), shareAfter = shareOf(topicAfter, worksAfter);
          if (shareBefore === shareAfter) continue;
          const subject = "topic-" + marketDigest([frame.source!.source_ref, frame.source!.revision, frame.market, frame.origin, topic]).slice(7, 31);
          persistAnalyzed({
            ...frameBase(frame, after.at),
            signal_ref: "signal-" + marketDigest([subject, frame.market, frame.origin, "topic-mix", MARKET_MAPPING_VERSION]).slice(7, 39),
            claim_kind: "topic_mix_changed", comparison: null,
            assertion_level: meetsMinimum && frameComplete ? "confirmed" : "observed",
            subject_ref: subject,
            title: "Topic " + topic + " share in " + frame.source!.source_ref + " sample",
            topics: [topic],
            observation_refs: citedAfter.map(o => o.observation_ref),
            evidence_refs: [...new Set(citedAfter.flatMap(o => o.evidence_refs))].sort(),
            topic_mix: {
              topic,
              before: { works: worksBefore, topic_works: topicBefore, share: shareBefore },
              after: { works: worksAfter, topic_works: topicAfter, share: shareAfter },
              snapshot_before: before.at, snapshot_after: after.at,
            },
            limitations: [
              "Topic share describes catalog supply inside one directory sample; it is not audience preference or demand.",
              ...(meetsMinimum ? [] : ["Sampling rule " + MARKET_CLAIM_GATES_VERSION + " requires at least " + TOPIC_MIX_MIN_WORKS + " independent works per window; this share change stays observed."]),
              ...(frameComplete ? [] : [completeness === "partial"
                ? "A recorded sampling check marks the later snapshot partial; the frame is not fixed and complete."
                : "The later snapshot has no completeness attestation; the frame is not proven fixed and complete."]),
              ...(afterObservations.length > AGGREGATE_REF_LIMIT
                ? ["Topic mix cites the first " + AGGREGATE_REF_LIMIT + " of " + afterObservations.length + " window observations."] : []),
            ],
          }, firstAfterRef, "topic_mix:" + topic);
        }
      }
    }
    // Cross-market claims: one topic seen in at least two evidenced regions.
    // Concrete country codes require market evidence at validation, so the
    // regional gate is structural; unknown and global markets never join.
    const touchedTopics = new Map<string, MarketObservation[]>();
    for (const row of rows) {
      const o = row.payload;
      if (!/^[A-Z]{2}$/.test(o.market)) continue;
      for (const topic of o.topics) {
        const list = touchedTopics.get(topic) ?? [];
        list.push(o);
        touchedTopics.set(topic, list);
      }
    }
    for (const [topic, windowObservations] of [...touchedTopics.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      // The claim subject is the topic across all history before the window
      // end, not only this window: regions observed earlier still form the
      // two evidenced observation sets the claim is about.
      const history = tx.select().from(marketObservations).where(lt(marketObservations.observedAt, until))
        .orderBy(marketObservations.observedAt, marketObservations.ref).all()
        .map(row => row.payload).filter(o => /^[A-Z]{2}$/.test(o.market) && o.topics.includes(topic));
      const markets = new Map<string, { observations: MarketObservation[]; sources: Map<string, NonNullable<ReturnType<typeof sourceByRef>>> }>();
      for (const o of history) {
        let side = markets.get(o.market);
        if (!side) { side = { observations: [], sources: new Map() }; markets.set(o.market, side); }
        side.observations.push(o);
        if (!side.sources.has(o.source_ref)) {
          const source = sourceByRef(tx, o.source_ref, o.source_revision);
          if (!source) throw new MarketStoreError("source_not_found", "Observation references an unavailable source revision.");
          side.sources.set(o.source_ref, source);
        }
      }
      if (markets.size < 2) continue;
      const sides = [...markets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([market, side]) => ({
        market, observations: side.observations.sort((a, b) => a.observation_ref.localeCompare(b.observation_ref)),
        sources: [...side.sources.values()].sort((a, b) => a.source_ref.localeCompare(b.source_ref)),
      }));
      // Same publisher group or a shared syndication chain is one source of
      // truth, never independent corroboration (design §3).
      const publisherGroups = [...new Set(sides.flatMap(s => s.sources.map(x => x.publisher_group)))].sort();
      const involved = sides.flatMap(s => s.observations);
      const observedAt = involved.reduce((max, o) => o.observed_at > max ? o.observed_at : max, involved[0].observed_at);
      const origin: MarketObservation["origin"] = involved.every(o => o.origin === "live") ? "live"
        : involved.some(o => o.origin === "fixture") ? "fixture" : "manual";
      const cited = involved.slice(0, AGGREGATE_REF_LIMIT);
      const subject = "topic-" + marketDigest([topic]).slice(7, 31);
      persistAnalyzed({
        spec: "radar.market_signal.v1" as const,
        signal_ref: "signal-" + marketDigest([subject, "cross-market"]).slice(7, 39),
        claim_kind: "cross_market_observed",
        assertion_level: publisherGroups.length >= 2 ? "corroborated" : "observed",
        subject_ref: subject,
        source_ref: "multi", market: "unknown",
        title: "Similar topic " + topic + " observed in " + sides.length + " evidenced markets",
        topics: [topic], observed_at: observedAt, lifecycle: "active" as const, comparison: null,
        observation_refs: cited.map(o => o.observation_ref),
        evidence_refs: [...new Set(cited.flatMap(o => [...o.evidence_refs, ...o.market_evidence_refs]))].sort(),
        cross_market: { topic, markets: sides.map(s => ({
          market: s.market, source_refs: s.sources.map(x => x.source_ref),
          publisher_groups: [...new Set(s.sources.map(x => x.publisher_group))].sort(),
          observation_refs: s.observations.slice(0, 3).map(o => o.observation_ref),
          market_evidence_refs: [...new Set(s.observations.flatMap(o => o.market_evidence_refs))].sort().slice(0, 3),
        })) },
        independent_evidence_groups: publisherGroups.length,
        limitations: [
          "Similar topic labels observed in different evidenced markets; this is not evidence of propagation, translation or causation.",
          "Topic similarity relies on exact versioned label mapping; shared labels do not establish the same work.",
          ...(involved.length > AGGREGATE_REF_LIMIT
            ? ["Cross-market claim cites the first " + AGGREGATE_REF_LIMIT + " of " + involved.length + " observations."] : []),
        ],
        analysis_version: MARKET_ANALYSIS_VERSION, mapping_version: MARKET_MAPPING_VERSION, origin,
      }, windowObservations[0].observation_ref, "cross_market:" + topic);
    }
    return { analysis_version: MARKET_ANALYSIS_VERSION, window: { start: from, end: until },
      observations: rows.length, created: results.filter(r => !r.reused).length,
      reused: results.filter(r => r.reused).length, signals: results.map(r => ({ ref: r.signal.signal_ref, revision: r.signal.revision })), skipped };
  }, { behavior: "immediate" });
}
