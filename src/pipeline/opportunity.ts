import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { RadarDb } from "../db/client.ts";
import { dailyItems, opportunities, opportunityItems } from "../db/schema.ts";

// opportunity-builder.v1 — deterministic topic/hook/format clustering of a
// day's scored items into radar.opportunity.v1 clusters. Missing metrics are
// never fabricated; each cluster keeps source refs and an evidence digest.

export const BUILDER_VERSION = "opportunity-builder.v1";

export interface ClusterItem {
  dailyItemId: number;
  platform: string;
  contentId: string;
  topic: string;
  hookFamily: string;
  score: number;
  confidence: number;
  degraded: boolean;
}

export interface BuiltOpportunity {
  ref: string;
  date: string;
  clusterKey: string;
  topic: string;
  hookFamily: string;
  format: string;
  marketScore: number;
  evidenceConfidence: number;
  degraded: boolean;
  crossPlatform: boolean;
  evidenceDigest: string;
  sourceRefs: string[];
  builderVersion: string;
  items: ClusterItem[];
}

interface ItemTags {
  topics?: string[];
  hooks?: string[];
  emotions?: string[];
}

export function buildOpportunities(db: RadarDb, date: string, now = new Date()): BuiltOpportunity[] {
  const rows = db.select().from(dailyItems).where(eq(dailyItems.date, date)).all();
  const groups = new Map<string, ClusterItem[]>();
  for (const row of rows) {
    const tags = safeTags(row.tagsJson);
    const topic = (tags.topics ?? [])[0] ?? "untagged";
    const hookFamily = (tags.hooks ?? [])[0] ?? "none";
    const key = `${topic}|${hookFamily}|default`;
    const list = groups.get(key) ?? [];
    list.push({
      dailyItemId: row.id,
      platform: row.platform,
      contentId: row.contentId,
      topic,
      hookFamily,
      score: row.score,
      confidence: row.confidence,
      degraded: row.degraded === 1,
    });
    groups.set(key, list);
  }

  const out: BuiltOpportunity[] = [];
  for (const [key, items] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const scores = items.map((i) => i.score).sort((a, b) => b - a);
    const top3 = scores.slice(0, 3);
    const marketScore = Math.round(0.7 * (scores[0] ?? 0) + 0.3 * (top3.reduce((s, v) => s + v, 0) / Math.max(1, top3.length)));
    const topConf = items.map((i) => i.confidence).sort((a, b) => b - a).slice(0, 3);
    const degradedRatio = items.filter((i) => i.degraded).length / items.length;
    const evidenceConfidence = clamp(Math.round(topConf.reduce((s, v) => s + v, 0) / Math.max(1, topConf.length) - 15 * degradedRatio));
    const evidenceDigest = `sha256:${createHash("sha256").update(items.map((i) => `${i.platform}:${i.contentId}`).sort().join(",")).digest("hex").slice(0, 16)}`;
    out.push({
      ref: oppRef(date, key),
      date,
      clusterKey: key,
      topic: items[0]!.topic,
      hookFamily: items[0]!.hookFamily,
      format: "default",
      marketScore,
      evidenceConfidence,
      degraded: items.some((i) => i.degraded),
      crossPlatform: new Set(items.map((i) => i.platform)).size > 1,
      evidenceDigest,
      sourceRefs: items.map((i) => `${i.platform}:${i.contentId}`),
      builderVersion: BUILDER_VERSION,
      items,
    });
  }
  return out;
}

// Persist the day's clusters (idempotent per date: existing refs are
// replaced so a rebuild after more data is deterministic).
export function persistOpportunities(db: RadarDb, date: string, now = new Date()): { clusters: number; items: number } {
  const built = buildOpportunities(db, date, now);
  const existing = db.select().from(opportunities).where(eq(opportunities.date, date)).all();
  for (const row of existing) {
    db.delete(opportunityItems).where(eq(opportunityItems.opportunityRef, row.ref)).run();
    db.delete(opportunities).where(eq(opportunities.ref, row.ref)).run();
  }
  let itemCount = 0;
  for (const opp of built) {
    db.insert(opportunities).values({
      ref: opp.ref,
      date,
      clusterKey: opp.clusterKey,
      topic: opp.topic,
      hookFamily: opp.hookFamily,
      format: opp.format,
      marketScore: opp.marketScore,
      evidenceConfidence: opp.evidenceConfidence,
      degraded: opp.degraded ? 1 : 0,
      crossPlatform: opp.crossPlatform ? 1 : 0,
      evidenceDigest: opp.evidenceDigest,
      sourceRefsJson: JSON.stringify(opp.sourceRefs),
      builderVersion: opp.builderVersion,
      createdAt: now.toISOString(),
    }).run();
    for (const item of opp.items) {
      db.insert(opportunityItems).values({ opportunityRef: opp.ref, dailyItemId: item.dailyItemId, platform: item.platform, contentId: item.contentId }).run();
      itemCount++;
    }
  }
  return { clusters: built.length, items: itemCount };
}

export function loadOpportunities(db: RadarDb, date: string): BuiltOpportunity[] {
  const rows = db.select().from(opportunities).where(eq(opportunities.date, date)).all();
  return rows.map((row) => ({
    ref: row.ref,
    date: row.date,
    clusterKey: row.clusterKey,
    topic: row.topic,
    hookFamily: row.hookFamily,
    format: row.format,
    marketScore: row.marketScore,
    evidenceConfidence: row.evidenceConfidence,
    degraded: row.degraded === 1,
    crossPlatform: row.crossPlatform === 1,
    evidenceDigest: row.evidenceDigest,
    sourceRefs: JSON.parse(row.sourceRefsJson) as string[],
    builderVersion: row.builderVersion,
    items: db.select().from(opportunityItems).where(eq(opportunityItems.opportunityRef, row.ref)).all().map((m) => ({
      dailyItemId: m.dailyItemId,
      platform: m.platform,
      contentId: m.contentId,
      topic: row.topic,
      hookFamily: row.hookFamily,
      score: 0, // membership rows do not carry scores; market fields live on the cluster
      confidence: 0,
      degraded: false,
    })),
  }));
}

export function opportunityByRef(db: RadarDb, ref: string): BuiltOpportunity | null {
  const row = db.select().from(opportunities).where(eq(opportunities.ref, ref)).all()[0];
  if (!row) return null;
  return loadOpportunities(db, row.date).find((o) => o.ref === ref) ?? null;
}

export function oppRef(date: string, clusterKey: string): string {
  return `opp-${date}-${createHash("sha256").update(clusterKey).digest("hex").slice(0, 8)}`;
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, n));
}

function safeTags(json: string): ItemTags {
  try {
    return JSON.parse(json) as ItemTags;
  } catch {
    return {};
  }
}
