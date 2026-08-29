import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Adapter, AdapterContext, FetchResult, RawItem } from "./types.ts";

interface ScrapeResponse {
  markdown?: string;
  success?: boolean;
  error?: string;
}

// Layer 0: public pages through the self-hosted Firecrawl service.
// Both platforms are covered: douyin hot list, xiaohongshu explore.
export function makeFirecrawlAdapter(platform: "douyin" | "xiaohongshu"): Adapter {
  const url =
    platform === "douyin"
      ? "https://www.douyin.com/hot"
      : "https://www.xiaohongshu.com/explore";
  return {
    name: `firecrawl-${platform}`,
    layer: 0,
    platform,
    async fetch(ctx: AdapterContext): Promise<FetchResult> {
      const errors: string[] = [];
      let markdown: string;
      try {
        if (ctx.fixtureDir) {
          markdown = readFileSync(join(ctx.fixtureDir, `${platform}-hot.md`), "utf8");
        } else {
          const res = await fetch(`${ctx.firecrawlBaseUrl}/v1/scrape`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url, formats: ["markdown"], timeout: 30_000 }),
            signal: AbortSignal.timeout(ctx.timeoutMs),
          });
          if (!res.ok) throw new Error(`firecrawl http ${res.status}`);
          const body = (await res.json()) as ScrapeResponse;
          if (body.error) throw new Error(body.error);
          markdown = body.markdown ?? "";
        }
        if (!markdown.trim()) throw new Error("empty markdown");
      } catch (err) {
        return { source: `firecrawl-${platform}`, layer: 0, items: [], degraded: true, errors: [`fetch failed: ${(err as Error).message}`] };
      }

      const items = parseHotList(platform, markdown);
      if (items.length === 0) errors.push("no parseable items in page (anti-bot or layout change?)");
      // Public hot lists lack per-item metrics and stable IDs; keep confidence low.
      return { source: `firecrawl-${platform}`, layer: 0, items, degraded: items.length === 0, errors };
    },
  };
}

// Best-effort markdown parser for public hot list pages. Layout changes break
// this on purpose loudly (empty result -> degraded), never silently.
export function parseHotList(platform: "douyin" | "xiaohongshu", markdown: string): RawItem[] {
  const items: RawItem[] = [];
  const seen = new Set<string>();
  const lines = markdown.split("\n");
  for (const line of lines) {
    const m = line.match(/\[(.+?)\]\((https?:\/\/[^)]+)\)/);
    if (!m) continue;
    const [, title, url] = m;
    const t = title.trim();
    if (t.length < 4) continue;
    if (!looksLikeContentUrl(platform, url)) continue;
    const contentId = url.split(/[/?#]/).filter(Boolean).pop() ?? createHash("sha256").update(url).digest("hex").slice(0, 16);
    if (seen.has(contentId)) continue;
    seen.add(contentId);
    items.push({
      platform,
      contentId,
      title: t.slice(0, 200),
      url,
      metrics: {},
      confidence: 40, // no metrics, no author context from public page
    });
    if (items.length >= 30) break;
  }
  return items;
}

function looksLikeContentUrl(platform: string, url: string): boolean {
  if (platform === "douyin") {
    return /douyin\.com\/(video|note)\//.test(url);
  }
  return /xiaohongshu\.com\/(exploration|discovery\/item|search_result)\//.test(url) || /xhslink\.com\//.test(url);
}
