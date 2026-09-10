import { createHash } from "node:crypto";
import { eq, and } from "drizzle-orm";
import type { RadarDb } from "../db/client.ts";
import { dailyItems, rawSnapshots } from "../db/schema.ts";
import type { Adapter, AdapterContext, FetchResult, RawItem } from "../adapters/types.ts";
import { makeFirecrawlAdapter } from "../adapters/firecrawl.ts";
import { makeXhsBackendAdapter } from "../adapters/agentreach-xhs.ts";
import { makeDouyinSignedAdapter } from "../adapters/douyin-signed.ts";
import { makeBrowserAdapter } from "../adapters/browser.ts";

// Data authority per collection layer — deliberately NOT layer number order.
// Layer 1 signed-API data is the most authoritative (real metrics, high
// confidence); a Layer 2 controlled-browser view beats a Layer 0 public-page
// scrape; Layer 3 manual import is an explicit degraded fallback. The spec
// scenario pins Layer 1 > Layer 0 for the same content id.
const LAYER_AUTHORITY: Record<number, number> = { 0: 0, 1: 3, 2: 2, 3: 1 };

export function layerAuthority(layer: number): number {
  return LAYER_AUTHORITY[layer] ?? 0;
}

// Merge a losing observation into the winning item: winner fields win,
// loser fills gaps (per-key metrics, missing title/author/publishedAt).
function mergeRawItem(winner: RawItem, loser: RawItem): RawItem {
  return {
    ...winner,
    metrics: { ...loser.metrics, ...winner.metrics },
    confidence: Math.max(winner.confidence, loser.confidence),
    title: winner.title || loser.title,
    url: winner.url || loser.url,
    authorId: winner.authorId || loser.authorId,
    authorName: winner.authorName || loser.authorName,
    publishedAt: winner.publishedAt || loser.publishedAt,
  };
}

export function defaultAdapters(opts: { xhsKeyword?: string; douyinKeyword?: string } = {}): Adapter[] {
  return [
    makeFirecrawlAdapter("douyin"),
    makeFirecrawlAdapter("xiaohongshu"),
    makeXhsBackendAdapter(opts.xhsKeyword ?? "短剧"),
    makeDouyinSignedAdapter(opts.douyinKeyword ?? "短剧"),
    makeBrowserAdapter("douyin"),
    makeBrowserAdapter("xiaohongshu"),
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

export interface CollectHooks {
  runId?: string;
  onLayer?: (result: FetchResult) => void;
}

export async function collect(
  db: RadarDb,
  adapters: Adapter[],
  ctx: AdapterContext,
  now: Date = new Date(),
  hooks: CollectHooks = {},
): Promise<CollectSummary> {
  const date = now.toISOString().slice(0, 10);
  const fetchedAt = now.toISOString();
  const runId = hooks.runId ?? `collect-${fetchedAt}`;
  const summary: CollectSummary = { runId, items: 0, snapshots: 0, degradedLayers: [], errors: [], date };
  const best = new Map<string, { item: RawItem; layer: number; source: string }>();

  for (const adapter of adapters) {
    let result: FetchResult;
    try {
      result = await adapter.fetch(ctx);
    } catch (err) {
      result = { source: adapter.name, layer: adapter.layer, items: [], degraded: true, errors: [`adapter threw: ${(err as Error).message}`] };
    }
    hooks.onLayer?.(result);
    summary.errors.push(...result.errors.map((e) => `${result.source}: ${e}`));
    if (result.degraded) summary.degradedLayers.push(result.source);
    for (const item of result.items) {
      const key = `${item.platform}:${item.contentId}`;
      // Keep the most authoritative record per content id (LAYER_AUTHORITY,
      // not layer number — Layer 1 signed API beats Layer 0 public pages);
      // the losing observation still fills field gaps in the winner.
      const existing = best.get(key);
      if (!existing) {
        best.set(key, { item, layer: result.layer, source: result.source });
      } else if (layerAuthority(result.layer) > layerAuthority(existing.layer)) {
        best.set(key, { item: mergeRawItem(item, existing.item), layer: result.layer, source: result.source });
      } else {
        best.set(key, { item: mergeRawItem(existing.item, item), layer: existing.layer, source: existing.source });
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
  if (!existing) {
    db.insert(dailyItems).values({
      date,
      platform: item.platform,
      contentId: item.contentId,
      title: item.title,
      url: item.url,
      authorId: item.authorId ?? "",
      publishedAt: item.publishedAt ?? "",
      metricsJson: JSON.stringify({ ...item.metrics }),
      confidence: item.confidence,
      degraded: layer >= 2 ? 1 : 0,
      sourceLayer: layer,
      updatedAt: fetchedAt,
    }).run();
    return;
  }
  // Cross-observation upsert. The observation from the more authoritative
  // layer owns the row; the other side fills per-key gaps. `sourceLayer`
  // records which layer owns the current metrics so `degraded` is recomputed
  // from the owning layer instead of silently following the last writer.
  const rowAuthority = existing.sourceLayer < 0 ? -1 : layerAuthority(existing.sourceLayer);
  const newWins = existing.sourceLayer < 0 || layerAuthority(layer) >= rowAuthority;
  const priorMetrics = JSON.parse(existing.metricsJson) as Record<string, number>;
  const merged = newWins
    ? { ...priorMetrics, ...item.metrics } // fresh authoritative values win per key
    : { ...item.metrics, ...priorMetrics }; // lower-authority fetch only fills gaps
  // Each observation's deltas describe only its own window: drop the prior
  // observation's delta keys before writing the new ones.
  for (const stale of DELTA_KEYS) delete merged[stale];
  Object.assign(merged, computeDeltas(priorMetrics, item.metrics, existing.updatedAt, fetchedAt));
  const ownerLayer = newWins ? layer : existing.sourceLayer;
  // Identity fields: the owning side's value wins, the other fills gaps.
  const pick = (winner: string, loser: string) => winner || loser;
  const next = {
    title: newWins ? pick(item.title, existing.title) : pick(existing.title, item.title),
    url: newWins ? pick(item.url, existing.url) : pick(existing.url, item.url),
    metricsJson: JSON.stringify(merged),
    confidence: Math.max(item.confidence, existing.confidence),
    degraded: ownerLayer >= 2 ? 1 : 0,
    sourceLayer: ownerLayer,
  };
  // Skip the write (and the updatedAt refresh) when nothing actually changed
  // so a no-op re-observation cannot make stale metrics look fresh.
  const changed = next.title !== existing.title || next.url !== existing.url ||
    next.metricsJson !== existing.metricsJson || next.confidence !== existing.confidence ||
    next.degraded !== existing.degraded || next.sourceLayer !== existing.sourceLayer;
  if (!changed) return;
  db.update(dailyItems).set({ ...next, updatedAt: fetchedAt }).where(eq(dailyItems.id, existing.id)).run();
}

// Absolute metric keys and the delta key each maps to. Deltas are computed
// between consecutive observations of the same content id so the spread
// signal can use engagement increments (spec: XHS spread MUST use
// engagement increments as proxy — play counts are never fabricated).
const ABS_TO_DELTA: Array<[string, string]> = [
  ["liked_count", "like_delta"],
  ["collected_count", "collect_delta"],
  ["comment_count", "comment_delta"],
  ["share_count", "share_delta"],
  ["digg_count", "digg_delta"],
  ["play_count", "play_delta"],
];
const DELTA_KEYS = [...ABS_TO_DELTA.map(([, d]) => d), "delta_window_hours"];

export function computeDeltas(
  prior: Record<string, number>,
  current: Record<string, number>,
  priorUpdatedAt: string,
  fetchedAt: string,
): Record<string, number> {
  const out: Record<string, number> = {};
  const windowHours = (Date.parse(fetchedAt) - Date.parse(priorUpdatedAt)) / 3_600_000;
  if (!Number.isFinite(windowHours) || windowHours <= 0) return out;
  for (const [absKey, deltaKey] of ABS_TO_DELTA) {
    const prev = prior[absKey];
    const curr = current[absKey];
    if (typeof prev === "number" && typeof curr === "number" && !Number.isNaN(prev) && !Number.isNaN(curr)) {
      out[deltaKey] = curr - prev;
    }
  }
  if (Object.keys(out).length > 0) out["delta_window_hours"] = Math.round(windowHours * 10) / 10;
  return out;
}
