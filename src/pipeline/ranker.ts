import type { RadarDb } from "../db/client.ts";
import type { PersonalProfileV1 } from "../profile/domain.ts";
import type { BuiltOpportunity } from "./opportunity.ts";
import { buildFeedbackAdjuster, matchedFeaturesOf, suppressedDigests } from "./feedback.ts";

// personal-ranker.v1 — deterministic personal rerank. Three public scores
// (market/fit/evidence confidence); internal rank score only orders and is
// never exposed as a user-facing "total score". Blocked topics hard-filter
// before scoring; feedback adjusts within [-15,+15].

export const RANKER_VERSION = "personal-ranker.v1";

export const REASON_CODES = [
  "topic_match",
  "hook_match",
  "asset_reuse",
  "budget_fit",
  "cross_platform_signal",
  "feedback_positive",
  "feedback_negative",
  "risk_near_limit",
  "low_confidence",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export interface RankedOpportunity {
  opportunity: BuiltOpportunity;
  personalFit: number;
  adjustment: number;
  reasonCodes: ReasonCode[];
  blocked: boolean;
  suppressed: boolean;
  rankScore: number; // internal tie-broken ordering only
}

export function rankOpportunities(db: RadarDb, profile: PersonalProfileV1, profileRef: string, opps: BuiltOpportunity[]): RankedOpportunity[] {
  const suppressed = suppressedDigests(db, profileRef);
  const adjust = buildFeedbackAdjuster(db, profileRef);
  const ranked = opps.map((opp) => rankOne(profile, opp, suppressed, adjust));
  // Blocked and suppressed clusters are excluded, never silently re-ranked.
  return ranked
    .filter((r) => !r.blocked && !r.suppressed)
    .sort((a, b) => tieBreak(a, b));
}

function tieBreak(a: RankedOpportunity, b: RankedOpportunity): number {
  // Stable order: rank score, then evidence confidence, market score, ref.
  return b.rankScore - a.rankScore
    || b.opportunity.evidenceConfidence - a.opportunity.evidenceConfidence
    || b.opportunity.marketScore - a.opportunity.marketScore
    || a.opportunity.ref.localeCompare(b.opportunity.ref);
}

function rankOne(profile: PersonalProfileV1, opp: BuiltOpportunity, suppressed: Set<string>, adjust: (features: string[]) => number): RankedOpportunity {
  const blocked = profile.blocked_topics.includes(opp.topic);
  const suppressedHit = suppressed.has(opp.evidenceDigest);
  const reasons: ReasonCode[] = [];

  // Weighted tag matches (0-100 each; absence contributes 0).
  const topicWeight = weightOf(profile.topics, opp.topic);
  const genreWeight = weightOf(profile.genres, opp.topic);
  const hookWeight = weightOf(profile.hooks, opp.hookFamily);
  if (topicWeight > 0 || genreWeight > 0) reasons.push("topic_match");
  if (hookWeight > 0) reasons.push("hook_match");

  // Asset reuse: cluster topic overlapping declared available assets.
  const assetReuse = profile.available_asset_tags.includes(opp.topic) ? 60 : 0;
  if (assetReuse > 0) reasons.push("asset_reuse");

  // Budget fit: micro budgets get full fit only for cheap topic families;
  // v1 keeps this intentionally conservative and explainable.
  const budgetFit = budgetFitOf(profile, opp);
  if (budgetFit >= 100) reasons.push("budget_fit");

  const base = Math.round(
    0.4 * Math.max(topicWeight, genreWeight) + 0.3 * hookWeight + 0.2 * assetReuse + 0.1 * budgetFit,
  );

  const adjustment = adjust(matchedFeaturesOf(opp));
  if (adjustment >= 2) reasons.push("feedback_positive");
  if (adjustment <= -2) reasons.push("feedback_negative");

  const personalFit = Math.max(0, Math.min(100, base + adjustment));

  if (opp.crossPlatform) reasons.push("cross_platform_signal");
  if (opp.evidenceConfidence < 60) reasons.push("low_confidence");
  if (personalFit >= 85 && profile.risk_tolerance < 30) reasons.push("risk_near_limit");

  const rankScore = Math.round(0.4 * opp.marketScore + 0.5 * personalFit + 0.1 * opp.evidenceConfidence);
  return { opportunity: opp, personalFit, adjustment, reasonCodes: reasons, blocked, suppressed: suppressedHit, rankScore };
}

function weightOf(tags: { tag: string; weight: number }[], tag: string): number {
  return tags.find((t) => t.tag === tag)?.weight ?? 0;
}

function budgetFitOf(profile: PersonalProfileV1, opp: BuiltOpportunity): number {
  // v1: premium/standard budgets fit everything; lean fits non-premium topics
  // (proxied by hook richness); micro fits lean hook families only. Honest
  // conservatism: unknown dimensions reduce fit instead of guessing.
  if (profile.budget_band === "premium" || profile.budget_band === "standard") return 100;
  const richHooks = ["identity_reversal", "conflict_first", "taboo"].includes(opp.hookFamily);
  if (profile.budget_band === "lean") return richHooks ? 60 : 100;
  return richHooks ? 30 : 70; // micro
}
