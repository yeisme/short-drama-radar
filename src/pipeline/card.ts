import { and, desc, eq } from "drizzle-orm";
import type { RadarDb } from "../db/client.ts";
import { dailyItems, runs } from "../db/schema.ts";

// Card payload handed to the "yunwan" delivery owner via a stable contract.
// Radar owns content and scores; delivery (feishu rendering/sending) is out of scope here.
export interface CardItem {
  rank: number;
  platform: "douyin" | "xiaohongshu";
  contentId: string;
  title: string;
  url: string;
  score: number;
  confidence: number;
  isNew: boolean;
  tags: { hooks: string[]; topics: string[]; emotions: string[] };
  degraded: boolean;
}

export interface CardPayload {
  contract: "short-drama-radar.card.v1";
  date: string;
  generatedAt: string;
  sourceStatus: {
    degraded: boolean;
    notes: string[];
  };
  trends: string[]; // filled by operator/human review until trend miner lands
  top: { douyin: CardItem[]; xiaohongshu: CardItem[] };
}

export function buildCard(db: RadarDb, date: string, generatedAt = new Date(), currentDegradedLayers?: string[]): CardPayload {
  const top5 = (platform: "douyin" | "xiaohongshu") =>
    db.select().from(dailyItems)
      .where(and(eq(dailyItems.date, date), eq(dailyItems.platform, platform)))
      .orderBy(desc(dailyItems.score))
      .all()
      .filter((row) => row.confidence >= 60)
      .slice(0, 5)
      .map((row, i) => ({
        rank: i + 1,
        platform,
        contentId: row.contentId,
        title: row.title,
        url: row.url,
        score: row.score,
        confidence: row.confidence,
        isNew: row.isNew === 1,
        tags: safeTags(row.tagsJson),
        degraded: row.degraded === 1,
      }));

  const douyin = top5("douyin");
  const xiaohongshu = top5("xiaohongshu");
  const degradedCount = db.select().from(dailyItems)
    .where(and(eq(dailyItems.date, date), eq(dailyItems.degraded, 1)))
    .all().length;
  const notes: string[] = [];
  if (degradedCount > 0) notes.push(`${degradedCount} items collected in degraded mode today.`);
  const degradedLayers = currentDegradedLayers ?? collectDegradedLayers(db, date);
  if (degradedLayers.length > 0) notes.push(`degraded source layers: ${degradedLayers.join(", ")}.`);
  const lowConfidenceCount = db.select().from(dailyItems)
    .where(eq(dailyItems.date, date))
    .all()
    .filter((row) => row.confidence < 60).length;
  if (lowConfidenceCount > 0) notes.push(`${lowConfidenceCount} low-confidence candidates excluded from automatic card entry.`);
  if (douyin.length < 5) notes.push(`douyin only has ${douyin.length} candidates (expected 5).`);
  if (xiaohongshu.length < 5) notes.push(`xiaohongshu only has ${xiaohongshu.length} candidates (expected 5).`);

  return {
    contract: "short-drama-radar.card.v1",
    date,
    generatedAt: generatedAt.toISOString(),
    sourceStatus: { degraded: degradedCount > 0 || degradedLayers.length > 0, notes },
    trends: [],
    top: { douyin, xiaohongshu },
  };
}

function collectDegradedLayers(db: RadarDb, date: string): string[] {
  const layers = new Set<string>();
  for (const run of db.select().from(runs).where(eq(runs.kind, "collect")).all()) {
    const runDate = run.startedAt.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? run.id.match(/\d{4}-\d{2}-\d{2}/)?.[0];
    if (runDate !== date) continue;
    try {
      const summary = JSON.parse(run.summaryJson) as { degradedLayers?: string[] };
      for (const layer of summary.degradedLayers ?? []) layers.add(layer);
    } catch {
      // A malformed historical receipt cannot make the card look healthier.
      layers.add("unknown-collect-receipt");
    }
  }
  return [...layers].sort();
}

function safeTags(json: string): { hooks: string[]; topics: string[]; emotions: string[] } {
  try {
    const t = JSON.parse(json) as { hooks?: string[]; topics?: string[]; emotions?: string[] };
    return { hooks: t.hooks ?? [], topics: t.topics ?? [], emotions: t.emotions ?? [] };
  } catch {
    return { hooks: [], topics: [], emotions: [] };
  }
}
