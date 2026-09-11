import { and, desc, eq, gt, gte, lt, lte } from "drizzle-orm";
import type { RadarDb } from "../db/client.ts";
import { marketReviews, marketSignals } from "../db/schema.ts";
import { isMarketInstant } from "./domain.ts";
import { marketDigest, MarketStoreError } from "./repository.ts";
import { marketReadPolicy } from "./policy.ts";
import type { MarketSignal } from "./signals.ts";

export interface ReviewEntry {
  original: MarketSignal; followup: MarketSignal | null;
  outcome: "sustained" | "cooled" | "retracted" | "inconclusive"; reason: string;
}
export interface MarketReview {
  spec: "radar.market_review.v1"; review_ref: string; digest: string;
  window: { start: string; end: string }; as_of: string; entries: ReviewEntry[];
  builder_version: string; limitations: string[];
}

function classify(original: MarketSignal, followup: MarketSignal | null): Pick<ReviewEntry, "outcome" | "reason"> {
  if (!followup) return { outcome: "inconclusive", reason: "No later signal evidence before the review cutoff." };
  if (followup.lifecycle === "retracted") return { outcome: "retracted", reason: "An explicit later correction retracts the prior claim." };
  if (followup.lifecycle === "inconclusive") return { outcome: "inconclusive", reason: "Later review states that evidence is insufficient." };
  const comparison = followup.comparison;
  if (comparison?.comparable && original.comparison?.comparable &&
    comparison.comparison_key === original.comparison.comparison_key) {
    const cooling = followup.claim_kind === "rank_changed" || followup.claim_kind === "placement_changed"
      ? comparison.change > 0 : comparison.change < 0;
    return { outcome: cooling ? "cooled" : "sustained", reason: "Later comparable observation; this is not a forecast accuracy score." };
  }
  return { outcome: "inconclusive", reason: "Later evidence cannot be compared with the original claim." };
}

export function buildMarketReview(db: RadarDb, start: string, end: string, asOf: string, now = new Date()) {
  if (![start, end, asOf].every(isMarketInstant) || !Number.isFinite(now.getTime()) ||
    Date.parse(start) >= Date.parse(end) || Date.parse(end) > Date.parse(asOf) || Date.parse(asOf) > now.getTime()) {
    throw new MarketStoreError("window_invalid", "Use an increasing review window ending no later than its cutoff, with no future cutoff.");
  }
  const window = { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
  const cutoff = new Date(asOf).toISOString();
  return db.transaction(tx => {
    const originals = tx.select().from(marketSignals).where(and(
      gte(marketSignals.observedAt, window.start), lt(marketSignals.observedAt, window.end),
    )).orderBy(marketSignals.ref, desc(marketSignals.revision)).all();
    const heads = new Map<string, MarketSignal>();
    for (const row of originals) if (!heads.has(row.ref)) heads.set(row.ref, row.payload);
    const entries = [...heads.values()].map((original): ReviewEntry => {
      const followup = tx.select().from(marketSignals).where(and(
        eq(marketSignals.ref, original.signal_ref), gt(marketSignals.revision, original.revision),
        gte(marketSignals.observedAt, window.end), lte(marketSignals.observedAt, cutoff),
      )).orderBy(desc(marketSignals.revision)).limit(1).get()?.payload ?? null;
      return { original, followup, ...classify(original, followup) };
    });
    const content = { spec: "radar.market_review.v1" as const, window, as_of: cutoff, entries,
      builder_version: "market-review-builder.v1", limitations: ["No later evidence is inconclusive, never a failed prediction."] };
    const digest = marketDigest(content), ref = "market-review-" + digest.slice(7, 39);
    const prior = tx.select().from(marketReviews).where(eq(marketReviews.ref, ref)).get();
    if (prior) return { review: prior.payload, reused: true };
    const review: MarketReview = { ...content, digest, review_ref: ref };
    tx.insert(marketReviews).values({ ref, windowEnd: window.end, cutoff, payload: review }).run();
    return { review, reused: false };
  }, { behavior: "immediate" });
}

export function readMarketReview(db: RadarDb, ref: string) {
  const review = db.select().from(marketReviews).where(eq(marketReviews.ref, ref)).get()?.payload;
  if (!review) throw new MarketStoreError("review_not_found", "Requested review does not exist.");
  const policy = marketReadPolicy(db);
  const readable = (s: MarketSignal) => !policy.blocked_topics.length ||
    (s.topics.length > 0 && !s.topics.some(t => policy.blocked_topics.includes(t)));
  const entries = review.entries.filter(e => readable(e.original) && (!e.followup || readable(e.followup)));
  return { ...review, entries, policy_revision: policy.policy_revision, filtered: entries.length !== review.entries.length };
}
