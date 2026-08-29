import { and, desc, eq } from "drizzle-orm";
import type { RadarDb } from "../db/client.ts";
import { dailyItems } from "../db/schema.ts";

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

export function buildCard(db: RadarDb, date: string, generatedAt = new Date()): CardPayload {
  const top5 = (platform: "douyin" | "xiaohongshu") =>
    db.select().from(dailyItems)
      .where(and(eq(dailyItems.date, date), eq(dailyItems.platform, platform)))
      .orderBy(desc(dailyItems.score))
      .limit(5)
      .all()
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
  if (douyin.length < 5) notes.push(`douyin only has ${douyin.length} candidates (expected 5).`);
  if (xiaohongshu.length < 5) notes.push(`xiaohongshu only has ${xiaohongshu.length} candidates (expected 5).`);

  return {
    contract: "short-drama-radar.card.v1",
    date,
    generatedAt: generatedAt.toISOString(),
    sourceStatus: { degraded: degradedCount > 0, notes },
    trends: [],
    top: { douyin, xiaohongshu },
  };
}

function safeTags(json: string): { hooks: string[]; topics: string[]; emotions: string[] } {
  try {
    const t = JSON.parse(json) as { hooks?: string[]; topics?: string[]; emotions?: string[] };
    return { hooks: t.hooks ?? [], topics: t.topics ?? [], emotions: t.emotions ?? [] };
  } catch {
    return { hooks: [], topics: [], emotions: [] };
  }
}
