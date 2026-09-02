import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Adapter, AdapterContext, FetchResult, RawItem } from "./types.ts";

interface ScrapeResponse {
  markdown?: string;
  rawHtml?: string;
  data?: { markdown?: string; rawHtml?: string };
  success?: boolean;
  error?: string;
}

export interface FirecrawlDeps {
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

// Layer 0: public pages through the self-hosted Firecrawl service.
// Both platforms are covered: douyin hot list, xiaohongshu explore.
export function makeFirecrawlAdapter(platform: "douyin" | "xiaohongshu", deps: FirecrawlDeps = {}): Adapter {
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
      let rawHtml = "";
      try {
        if (ctx.fixtureDir) {
          markdown = readFileSync(join(ctx.fixtureDir, `${platform}-hot.md`), "utf8");
        } else {
          const res = await (deps.fetchImpl ?? fetch)(`${ctx.firecrawlBaseUrl}/v1/scrape`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url, formats: ["markdown", "rawHtml"], timeout: 30_000, maxAge: 0 }),
            signal: AbortSignal.timeout(ctx.timeoutMs),
          });
          if (!res.ok) throw new Error(`firecrawl http ${res.status}`);
          const body = (await res.json()) as ScrapeResponse;
          if (body.error) throw new Error(body.error);
          markdown = body.data?.markdown ?? body.markdown ?? "";
          rawHtml = body.data?.rawHtml ?? body.rawHtml ?? "";
        }
        if (!markdown.trim() && !rawHtml.trim()) throw new Error("empty markdown and rawHtml");
      } catch (err) {
        return { source: `firecrawl-${platform}`, layer: 0, items: [], degraded: true, errors: [`fetch failed: ${(err as Error).message}`] };
      }

      const items = parseHotList(platform, markdown);
      if (items.length === 0 && rawHtml) items.push(...parsePublicHtml(platform, rawHtml));
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
    const t = cleanTitle(title);
    if (t.length < 4) continue;
    if (!looksLikeContentUrl(platform, url)) continue;
    const contentId = contentIdFromUrl(platform, url) ?? createHash("sha256").update(url).digest("hex").slice(0, 16);
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

export function parsePublicHtml(platform: "douyin" | "xiaohongshu", html: string): RawItem[] {
  const items: RawItem[] = [];
  const seen = new Set<string>();
  const anchors = /<a\b[^>]*href=(?:"([^"]+)"|'([^']+)')[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchors)) {
    const href = (match[1] ?? match[2] ?? "").replaceAll("&amp;", "&");
    const absolute = href.startsWith("http")
      ? href
      : `https://www.${platform === "douyin" ? "douyin.com" : "xiaohongshu.com"}${href.startsWith("/") ? href : `/${href}`}`;
    if (!looksLikeContentUrl(platform, absolute)) continue;
    const contentId = contentIdFromUrl(platform, absolute);
    if (!contentId || seen.has(contentId)) continue;
    let title = cleanTitle(match[3] ?? "");
    if (title.length < 4 && platform === "douyin") {
      const encoded = absolute.split("/").pop()?.split(/[?#]/)[0] ?? "";
      try { title = cleanTitle(decodeURIComponent(encoded)); } catch { /* keep the parsed title */ }
    }
    if (title.length < 4) continue;
    seen.add(contentId);
    items.push({ platform, contentId, title: title.slice(0, 200), url: absolute, metrics: {}, confidence: 40 });
    if (items.length >= 30) break;
  }
  return items;
}

function looksLikeContentUrl(platform: string, url: string): boolean {
  if (platform === "douyin") {
    return /douyin\.com\/(video|note|hot)\//.test(url);
  }
  return /xiaohongshu\.com\/(explore|exploration|discovery\/item|search_result)\//.test(url) || /xhslink\.com\//.test(url);
}

function contentIdFromUrl(platform: string, url: string): string | null {
  if (platform === "douyin") return url.match(/\/(?:video|note|hot)\/(\d+)/)?.[1] ?? null;
  return url.match(/\/(?:explore|exploration|discovery\/item|search_result)\/([0-9a-f]+)/)?.[1]
    ?? url.match(/xhslink\.com\/([^/?#]+)/)?.[1]
    ?? null;
}

function cleanTitle(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/^\s*#{1,6}\s*/, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
