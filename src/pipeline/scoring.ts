import { and, desc, eq, ne } from "drizzle-orm";
import type { RadarDb } from "../db/client.ts";
import { dailyItems } from "../db/schema.ts";
import { tagContent } from "./tags.ts";

export const WEIGHTS = {
  spread: 0.4,
  topic: 0.25,
  hook: 0.2,
  emotion: 0.15,
} as const;

// v0 score = 0.40*spread + 0.25*topic + 0.20*hook + 0.15*emotion,
// each signal normalized 0-100 within (platform, day).
// Spread uses metric deltas between the day's two collection passes when
// available; on a single pass it falls back to absolute values. XHS has no
// public play count, so like+collect+comment increments act as the spread
// proxy — never fabricate a play count.
export interface ScoreSummary {
  date: string;
  scored: number;
  lowConfidence: number;
}

export function spreadValue(platform: string, metrics: Record<string, number>): number {
  // Engagement deltas between passes when this observation produced any
  // (per-item basis: mixing delta and absolute terms would add inconsistent
  // scales); a single-pass observation falls back to absolute totals. The
  // normalizer writes comment_count (not comments_count) — the previous
  // misspelling silently dropped all comment engagement from the spread.
  // Play counts are never fabricated.
  if (platform === "douyin") {
    return metrics.digg_delta ?? metrics.digg_count ?? metrics.like_count ?? 0;
  }
  const hasDelta = metrics.like_delta !== undefined || metrics.collect_delta !== undefined || metrics.comment_delta !== undefined;
  if (hasDelta) {
    return (metrics.like_delta ?? 0) + (metrics.collect_delta ?? 0) + (metrics.comment_delta ?? 0);
  }
  return (metrics.liked_count ?? 0) + (metrics.collected_count ?? 0) + (metrics.comment_count ?? 0);
}

export async function scoreDay(db: RadarDb, date: string): Promise<ScoreSummary> {
  const rows = db.select().from(dailyItems).where(eq(dailyItems.date, date)).all();
  const byPlatform = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byPlatform.get(row.platform) ?? [];
    list.push(row);
    byPlatform.set(row.platform, list);
  }

  const summary: ScoreSummary = { date, scored: 0, lowConfidence: 0 };
  for (const [platform, list] of byPlatform) {
    const spreads = list.map((r) => spreadValue(platform, JSON.parse(r.metricsJson)));
    const topicCounts = countTopicFrequencies(db, platform, date);
    const maxSpread = Math.max(1, ...spreads.map(Math.abs));

    list.forEach((row, i) => {
      const metrics = JSON.parse(row.metricsJson) as Record<string, number>;
      const tags = tagContent(row.title);
      const spreadNorm = (spreads[i] / maxSpread) * 100;
      const topics = tags.topics.length > 0 ? tags.topics : ["untagged"];
      const topicNorm = Math.min(100, ((topicCounts.get(topics[0]) ?? 1) / Math.max(1, ...topicCounts.values())) * 100);
      const hookNorm = (tags.hookDensity / 5) * 100;
      const emotionNorm = ((tags.emotionIntensity - 1) / 4) * 100;
      const score = Math.round(
        WEIGHTS.spread * spreadNorm + WEIGHTS.topic * topicNorm + WEIGHTS.hook * hookNorm + WEIGHTS.emotion * emotionNorm,
      );
      const confidence = row.confidence; // 0-100 as stored by adapters
      const tagsJson = JSON.stringify(tags);
      const isNew = priorDayHas(db, date, platform, row.contentId) ? 0 : 1;
      db.update(dailyItems).set({ score, confidence, tagsJson, isNew }).where(eq(dailyItems.id, row.id)).run();
      summary.scored++;
      if (confidence < 60) summary.lowConfidence++;
    });
  }
  return summary;
}

// Topic frequency: occurrences in the last 7 days including today.
// v0 falls back to same-day counts until 7 days of history exist.
function countTopicFrequencies(db: RadarDb, platform: string, date: string): Map<string, number> {
  const counts = new Map<string, number>();
  const recent = db.select().from(dailyItems)
    .where(and(eq(dailyItems.platform, platform), ne(dailyItems.date, "")))
    .orderBy(desc(dailyItems.date))
    .all()
    .filter((r) => r.date <= date && r.date >= shiftDate(date, -7));
  for (const row of recent) {
    try {
      const tags = JSON.parse(row.tagsJson) as { topics?: string[] };
      for (const t of tags.topics ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
    } catch {
      // rows not yet tagged are skipped
    }
  }
  return counts;
}

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// "new on board": same content id absent from the previous calendar day.
function priorDayHas(db: RadarDb, date: string, platform: string, contentId: string): boolean {
  const prior = shiftDate(date, -1);
  return db.select().from(dailyItems)
    .where(and(eq(dailyItems.date, prior), eq(dailyItems.platform, platform), eq(dailyItems.contentId, contentId)))
    .all().length > 0;
}
