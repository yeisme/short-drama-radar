import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RadarDb } from "../db/client.ts";
import { defaultConfig } from "../config.ts";
import { CATALOG_SAMPLE_PAGES, ingestCatalog, parseCatalog } from "./catalog.ts";
import { MarketStoreError, sourceByRef } from "./repository.ts";
import { isMarketInstant, type SourceReadiness } from "./domain.ts";
import { MARKET_OBSERVE_POLICY } from "./schedule.ts";

export const HONGUO_LIVE_SOURCE = "hongguo";
export type ObserveMode = "verify-sample" | "production";

export interface ObserveInput {
  source: string;
  mode: ObserveMode;
  confirmLive?: boolean;
  fixture?: boolean;
  fixtureDir?: string;
  observedAt?: string;
  firecrawlBaseUrl?: string;
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  now?: Date;
}

const PRODUCTION_READY: readonly SourceReadiness[] = ["sample_verified", "qualified"];

interface ScrapeResponse {
  markdown?: string;
  rawHtml?: string;
  data?: { markdown?: string; rawHtml?: string };
  error?: string;
}

export async function observeCatalog(db: RadarDb, input: ObserveInput) {
  if (input.source !== HONGUO_LIVE_SOURCE) {
    throw new MarketStoreError("source_unsupported", "Live observation in this slice is only enabled for hongguo.");
  }
  if (input.mode !== "verify-sample" && input.mode !== "production") {
    throw new MarketStoreError("mode_invalid", "mode must be verify-sample or production.");
  }
  if (input.fixture && input.confirmLive) {
    throw new MarketStoreError("flag_invalid", "Use either --fixture or --confirm-live, not both.");
  }
  if (!input.fixture && !input.confirmLive) {
    throw new MarketStoreError("owner_authorization_required",
      "Live observation needs --confirm-live; use --fixture only for offline path tests.");
  }
  const source = sourceByRef(db, input.source);
  if (!source) throw new MarketStoreError("source_not_found", "Run 'radar market init' before observing.");
  if (source.readiness === "blocked") throw new MarketStoreError("source_blocked", "Blocked sources cannot be observed.");
  if (input.mode === "production" && !PRODUCTION_READY.includes(source.readiness)) {
    throw new MarketStoreError("qualification_required",
      "Production observe requires sample_verified or qualified; use --mode verify-sample for authorized sampling.");
  }
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new MarketStoreError("time_invalid", "Observation clock must be valid.");
  const instant = input.observedAt ?? now.toISOString();
  if (!isMarketInstant(instant)) throw new MarketStoreError("observation_invalid", "Provide the observation time as a UTC instant.");
  const origin = input.fixture ? "fixture" as const : "live" as const;
  const sampleUrl = CATALOG_SAMPLE_PAGES[input.source];
  if (!sampleUrl) throw new MarketStoreError("source_unsupported", "No live catalog sample page is registered.");

  let html: string;
  if (input.fixture) {
    const dir = input.fixtureDir ?? process.env.RADAR_FIXTURE_DIR;
    if (!dir) throw new MarketStoreError("input_unavailable", "Fixture observe requires RADAR_FIXTURE_DIR or an explicit fixture directory.");
    try { html = readFileSync(join(dir, "market/hongguo-fields.html"), "utf8"); }
    catch { throw new MarketStoreError("input_unavailable", "Hongguo fixture catalog could not be read."); }
  } else {
    html = await scrapeCatalogHtml(sampleUrl, input.firecrawlBaseUrl ?? defaultConfig.firecrawlBaseUrl,
      input.fetchImpl ?? fetch, MARKET_OBSERVE_POLICY.source_timeout_ms);
  }

  const parsed = await parseCatalog(input.source, html, "html");
  if (parsed.status === "unavailable") {
    throw new MarketStoreError("source_unavailable",
      "No parseable catalog items; the page may be a login wall, empty, or a layout change.");
  }
  const receipt = await ingestCatalog(db, {
    source: input.source, content: html, format: "html", observedAt: instant, origin,
  });
  return {
    spec: "radar.market_observe.v1" as const,
    source_ref: source.source_ref,
    source_revision: source.revision,
    mode: input.mode,
    sample_url: input.fixture ? "fixture://hongguo-fields.html" : sampleUrl,
    readiness_unchanged: source.readiness,
    ...receipt,
    limitations: [
      ...(receipt.limitations ?? []),
      input.mode === "verify-sample"
        ? "Verification samples do not mark coverage mature or promote readiness."
        : "Production observe does not enable timers; enabling schedule units is an owner action.",
    ],
  };
}

async function scrapeCatalogHtml(
  url: string,
  firecrawlBaseUrl: string,
  fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  timeoutMs: number,
): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl(`${firecrawlBaseUrl.replace(/\/$/, "")}/v1/scrape`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, formats: ["markdown", "rawHtml"], timeout: 30_000, maxAge: 0 }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new MarketStoreError("source_unavailable", `Catalog scrape failed: ${(err as Error).message}`);
  }
  if (!res.ok) throw new MarketStoreError("source_unavailable", `Catalog scrape HTTP ${res.status}.`);
  let body: ScrapeResponse;
  try { body = await res.json() as ScrapeResponse; }
  catch { throw new MarketStoreError("source_unavailable", "Catalog scrape returned non-JSON."); }
  if (body.error) throw new MarketStoreError("source_unavailable", "Catalog scrape reported a provider error.");
  const html = body.data?.rawHtml ?? body.rawHtml ?? "";
  if (!html.trim()) throw new MarketStoreError("source_unavailable", "Catalog scrape returned empty HTML.");
  return html;
}
