import { emptyResult, type Adapter, type AdapterContext, type FetchResult, type RawItem } from "./types.ts";
import { DOUYIN_WEB_UA, generateXBogus } from "./xbogus.ts";

// Layer 1 (douyin): self-maintained signed web API layer. The X-Bogus signer
// is ported from public reverse engineering and verified against reference
// vectors (test/unit/xbogus.test.ts). Risk control, cookie walls or endpoint
// drift degrade loudly — this adapter never fabricates metrics.

interface DouyinFetchDeps {
  fetchJson?: (url: string, init: RequestInit) => Promise<unknown>;
  now?: () => number;
}

export const DOUYIN_ENDPOINTS = {
  search: "https://www.douyin.com/aweme/v1/web/search/item/",
  detail: "https://www.douyin.com/aweme/v1/web/aweme/detail/",
} as const;

// Minimal stable web param set; keep the order — the signature covers the
// exact query string bytes.
function baseParams(): string {
  return [
    "device_platform=webapp",
    "aid=6383",
    "channel=global",
    "search_channel=aweme_general",
    "sort_type=0",
    "publish_time=0",
    "search_source=normal_search",
    "query_correct_type=1",
    "is_filter_search=0",
    "from_group_id=",
    "offset=0",
    "count=10",
    "need_aweme_vo=0",
    "api_version=1",
    "version_code=170400",
    "cookie_enabled=true",
    "platform=PC",
    "downlink=10",
    "screen_width=1920",
    "screen_height=1080",
    "browser_language=zh-CN",
    "browser_platform=Win32",
    "browser_name=Chrome",
    "browser_version=122.0.0.0",
  ].join("&");
}

export function searchQuery(keyword: string): string {
  return `${baseParams()}&keyword=${encodeURIComponent(keyword)}&search_id=`;
}


export function makeDouyinSignedAdapter(keyword = "短剧"): Adapter {
  return {
    name: "douyin-signed-api",
    layer: 1,
    platform: "douyin",
    async fetch(ctx: AdapterContext, deps: DouyinFetchDeps = {}): Promise<FetchResult> {
      if (ctx.fixtureDir) {
        const path = `${ctx.fixtureDir}/douyin-layer1.json`;
        const file = Bun.file(path);
        if (await file.exists()) {
          const r = normalizeSearch(JSON.parse(await file.text()));
          return { source: "douyin-signed-api", layer: 1, items: r.items, degraded: r.items.length === 0, errors: r.errors };
        }
        return emptyResult("douyin-signed-api", 1, [`fixture ${path} not found`]);
      }
      const fetchJson = deps.fetchJson ?? ((url, init) => fetch(url, init).then((r) => r.json()));
      const nowSec = Math.floor((deps.now?.() ?? Date.now()) / 1000);
      const errors: string[] = [];
      const items: RawItem[] = [];
      // Login cookies (user-level secret) may be injected via env; they are
      // never logged, persisted or echoed into evidence.
      const headers: Record<string, string> = {
        "User-Agent": DOUYIN_WEB_UA,
        Referer: "https://www.douyin.com/search",
        Accept: "application/json",
      };
      const cookie = process.env["DOUYIN_COOKIE"];
      if (cookie) headers["Cookie"] = cookie;

      try {
        const query = searchQuery(keyword);
        const url = `${DOUYIN_ENDPOINTS.search}?${query}&X-Bogus=${generateXBogus(query, DOUYIN_WEB_UA, nowSec)}`;
        const payload = (await fetchJson(url, {
          headers,
          signal: AbortSignal.timeout(ctx.timeoutMs),
        })) as Record<string, unknown>;
        const result = normalizeSearch(payload);
        items.push(...result.items);
        errors.push(...result.errors);
      } catch (err) {
        errors.push(`search endpoint failed: ${(err as Error).message}`);
      }

      return { source: "douyin-signed-api", layer: 1, items, degraded: items.length === 0, errors };
    },
  };
}

// Normalize a search-item response. `data[].aweme_info` is the stable shape;
// anything else (risk-control HTML parsed as JSON would throw upstream, empty
// data with status_code != 0) is a degraded result with a real reason.
export function normalizeSearch(payload: unknown): { items: RawItem[]; errors: string[] } {
  const items: RawItem[] = [];
  const errors: string[] = [];
  if (typeof payload !== "object" || payload === null) {
    return { items, errors: ["payload is not an object"] };
  }
  const obj = payload as Record<string, unknown>;
  const statusCode = typeof obj["status_code"] === "number" ? (obj["status_code"] as number) : null;
  const rows = Array.isArray(obj["data"]) ? (obj["data"] as Record<string, unknown>[]) : [];
  for (const row of rows) {
    const info = row["aweme_info"];
    if (typeof info !== "object" || info === null) continue;
    const item = normalizeAweme(info as Record<string, unknown>);
    if (item) {
      items.push(item);
      if (items.length >= 30) break;
    }
  }
  if (items.length === 0) {
    if (statusCode === 2483) errors.push("douyin requires login cookies for search (set DOUYIN_COOKIE from your user secret store)");
    else if (statusCode !== null && statusCode !== 0) errors.push(`douyin status_code ${statusCode} (risk control or auth required)`);
    else if ("log_pb" in obj || "mix_list" in obj) errors.push("search response shape not recognized (endpoint drift?)");
    else errors.push("no aweme_info rows returned (cookie wall or empty keyword result)");
  }
  return { items, errors };
}

// Normalize a single aweme_info object into a RawItem; missing id/title yields
// null instead of a fabricated row.
export function normalizeAweme(info: Record<string, unknown>): RawItem | null {
  const awemeId = str(info["aweme_id"]);
  const title = str(info["desc"]);
  if (!awemeId || !title) return null;
  const stats = (info["statistics"] ?? {}) as Record<string, unknown>;
  const author = (info["author"] ?? {}) as Record<string, unknown>;
  const metrics: Record<string, number> = {};
  const map: [string, string][] = [
    ["digg_count", "digg_count"],
    ["comment_count", "comment_count"],
    ["collect_count", "collect_count"],
    ["share_count", "share_count"],
  ];
  for (const [src, dst] of map) {
    const v = stats[src];
    if (typeof v === "number" && Number.isFinite(v)) metrics[dst] = v;
  }
  return {
    platform: "douyin",
    contentId: awemeId,
    title: title.slice(0, 200),
    url: `https://www.douyin.com/video/${awemeId}`,
    authorId: str(author["sec_uid"]),
    authorName: str(author["nickname"]),
    publishedAt: typeof info["create_time"] === "number" ? new Date((info["create_time"] as number) * 1000).toISOString() : "",
    metrics,
    // Signed API rows carry stable IDs and real engagement counters.
    confidence: 80,
  };
}


function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
