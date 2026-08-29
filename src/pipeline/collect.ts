import { createHash } from "node:crypto";
import { eq, and } from "drizzle-orm";
import type { RadarDb } from "../db/client.ts";
import { dailyItems, rawSnapshots } from "../db/schema.ts";
import type { Adapter, AdapterContext, FetchResult, RawItem } from "../adapters/types.ts";
import { makeFirecrawlAdapter } from "../adapters/firecrawl.ts";
import { browserFallbackAdapter, douyinSignedAdapter, xiaohongshuBackendAdapter } from "../adapters/xiaohongshu.ts";

export function defaultAdapters(): Adapter[] {
  return [
    makeFirecrawlAdapter("douyin"),
    makeFirecrawlAdapter("xiaohongshu"),
    xiaohongshuBackendAdapter,
    douyinSignedAdapter,
    browserFallbackAdapter,
  ];
}

export interface CollectSummary {
  runId: string;
  items: number;
  snapshots: number;
  degradedLayers: string[];
  errors: string[];
  date: string;
}

export async function collect(
  db: RadarDb,
  adapters: Adapter[],
  ctx: AdapterContext,
  now: Date = new Date(),
): Promise<CollectSummary> {
  const date = now.toISOString().slice(0, 10);
  const fetchedAt = now.toISOString();
  const runId = `collect-${fetchedAt}`;
  const summary: CollectSummary = { runId, items: 0, snapshots: 0, degradedLayers: [], errors: [], date };
  const best = new Map<string, { item: RawItem; layer: number; source: string }>();

  for (const adapter of adapters) {
    let result: FetchResult;
    try {
      result = await adapter.fetch(ctx);
    } catch (err) {
      result = { source: adapter.name, layer: adapter.layer, items: [], degraded: true, errors: [`adapter threw: ${(err as Error).message}`] };
    }
    summary.errors.push(...result.errors.map((e) => `${result.source}: ${e}`));
    if (result.degraded) summary.degradedLayers.push(result.source);
    for (const item of result.items) {
      const key = `${item.platform}:${item.contentId}`;
      // Prefer the lowest layer (most authoritative) per content id.
      const existing = best.get(key);
      if (!existing || result.layer < existing.layer) {
        best.set(key, { item, layer: result.layer, source: result.source });
      }
    }
    // Raw receipts are stored for every adapter, even empty ones, as evidence.
    for (const item of result.items) {
      db.insert(rawSnapshots).values({
        runId,
        platform: item.platform,
        layer: result.layer,
        source: result.source,
        contentId: item.contentId,
        title: item.title,
        url: item.url,
        authorId: item.authorId ?? "",
        authorName: item.authorName ?? "",
        publishedAt: item.publishedAt ?? "",
        metricsJson: JSON.stringify(item.metrics),
        payloadHash: createHash("sha256").update(`${item.platform}:${item.contentId}:${JSON.stringify(item.metrics)}`).digest("hex").slice(0, 16),
        confidence: item.confidence,
        degraded: result.degraded ? 1 : 0,
        fetchedAt,
      }).run();
      summary.snapshots++;
    }
  }

  for (const { item, layer, source } of best.values()) {
    upsertDailyItem(db, date, item, layer, source, fetchedAt);
    summary.items++;
  }
  return summary;
}

function upsertDailyItem(db: RadarDb, date: string, item: RawItem, layer: number, source: string, fetchedAt: string): void {
  const existing = db.select().from(dailyItems)
    .where(and(eq(dailyItems.date, date), eq(dailyItems.platform, item.platform), eq(dailyItems.contentId, item.contentId)))
    .all()[0];
  // Merge metrics: keep prior values for keys the new fetch is missing.
  const priorMetrics = existing ? (JSON.parse(existing.metricsJson) as Record<string, number>) : {};
  const metrics = { ...priorMetrics, ...item.metrics };
  if (existing) {
    db.update(dailyItems).set({
      title: item.title || existing.title,
      url: item.url || existing.url,
      metricsJson: JSON.stringify(metrics),
      confidence: Math.max(item.confidence, existing.confidence),
      updatedAt: fetchedAt,
    }).where(eq(dailyItems.id, existing.id)).run();
  } else {
    db.insert(dailyItems).values({
      date,
      platform: item.platform,
      contentId: item.contentId,
      title: item.title,
      url: item.url,
      authorId: item.authorId ?? "",
      publishedAt: item.publishedAt ?? "",
      metricsJson: JSON.stringify(metrics),
      confidence: item.confidence,
      degraded: layer >= 2 ? 1 : 0,
      updatedAt: fetchedAt,
    }).run();
  }
}
