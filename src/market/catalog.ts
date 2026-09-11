import type { RadarDb } from "../db/client.ts";
import { marketEvidence } from "../db/schema.ts";
import { isMarketInstant, parseMarketObservation, type MarketObservation, type MarketSource } from "./domain.ts";
import { marketDigest, MarketStoreError, saveObservationBatch, sourceByRef } from "./repository.ts";
import { refreshWorkCandidate, workSubjectRef } from "./identity.ts";

export const CATALOG_PAGES: Record<string, string> = {
  hongguo: "https://novelquickapp.com/hongguo",
  reelshort: "https://www.reelshort.com/",
  dramabox: "https://www.dramabox.com/",
};

export interface CatalogItem { id: string; title: string; url: string }
export interface CatalogResult {
  items: CatalogItem[];
  status: "parsed" | "unavailable";
  reason: string | null;
}

function identity(source: string, href: string): { id: string; url: string } | null {
  const base = CATALOG_PAGES[source];
  if (!base) return null;
  let url: URL;
  try { url = new URL(href, base); } catch { return null; }
  if (url.protocol !== "https:" || url.host !== new URL(base).host || url.username || url.password) return null;
  let id: string | undefined;
  if (source === "hongguo" && url.pathname === "/detail") {
    const series = url.searchParams.get("series_id");
    if (series && /^\d{5,24}$/.test(series)) {
      id = series;
      url.search = "?series_id=" + series;
    }
  } else if (source === "reelshort") {
    id = url.pathname.match(/^\/movie\/[a-z0-9-]+-([a-f0-9]{24})\/?$/i)?.[1];
    url.search = "";
  } else if (source === "dramabox") {
    id = url.pathname.match(/^\/drama\/(\d{5,24})\/[^/]+\/?$/)?.[1];
    url.search = "";
  }
  if (!id) return null;
  url.hash = "";
  return { id, url: url.href };
}

// HTMLRewriter is Bun's native parser. It avoids using a regex as an HTML
// parser and ignores scripts; only recognized work links enter observations.
export async function parseCatalog(source: string, content: string, format: "html" | "markdown"): Promise<CatalogResult> {
  if (!CATALOG_PAGES[source]) throw new MarketStoreError("source_unsupported", "No catalog parser is registered for this source.");
  if (typeof content !== "string" || Buffer.byteLength(content) > 2_000_000) throw new MarketStoreError("input_too_large", "Catalog input must not exceed 2 MB.");
  const links: Array<{ href: string; title: string }> = [];
  if (format === "html") {
    // Track each anchor independently, including image-only title links.
    let active: { href: string; title: string } | undefined;
    const parser = new HTMLRewriter()
      .on("a", {
        element(el) {
          const entry = { href: el.getAttribute("href") ?? "", title: el.getAttribute("aria-label") ?? "" };
          active = entry;
          links.push(entry);
          el.onEndTag(() => { active = undefined; });
        },
        text(chunk) { if (active) active.title += chunk.text; },
      })
      .on("a img", { element(el) { if (active && !active.title.trim()) active.title = el.getAttribute("alt") ?? ""; } });
    await parser.transform(new Response(content)).text();
  } else {
    // Supported extraction format is a plain Markdown link. Image wrappers
    // need a text title link elsewhere; no speculative fallback title from ID.
    for (const match of content.matchAll(/(?<!!)\[([^\[\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g)) {
      links.push({ title: match[1], href: match[2] });
    }
  }
  const items = new Map<string, CatalogItem>();
  for (const link of links) {
    const work = identity(source, link.href);
    const title = link.title.replace(/\s+/g, " ").trim();
    if (!work || title.length < 2 || title.length > 500) continue;
    if (!items.has(work.id)) items.set(work.id, { ...work, title });
    if (items.size > 1000) throw new MarketStoreError("batch_too_large", "Catalog exceeds 1000 works; use a bounded sampling page.");
  }
  if (!items.size) return { items: [], status: "unavailable", reason: "no_parseable_catalog_items" };
  return { items: [...items.values()], status: "parsed", reason: null };
}

export async function importCatalog(db: RadarDb, input: {
  source: string; content: string; format: "html" | "markdown";
  observedAt: string; origin: "manual" | "fixture";
}) {
  const source = sourceByRef(db, input.source);
  if (!source) throw new MarketStoreError("source_not_found", "Run 'radar market init' before importing a catalog.");
  if (!isMarketInstant(input.observedAt)) throw new MarketStoreError("observation_invalid", "Provide the original observation time as a UTC instant.");
  const parsed = await parseCatalog(input.source, input.content, input.format);
  if (parsed.status === "unavailable") throw new MarketStoreError("source_unavailable", "No parseable catalog items; verify the page and parser before importing.");
  // Directory order is not a rank metric. Reordered links represent the
  // same sample unless the adapter has a separately verified ranking basis.
  parsed.items.sort((a, b) => a.id.localeCompare(b.id));
  const observedAt = new Date(input.observedAt).toISOString();
  const batchRef = "catalog-batch-" + marketDigest([source.source_ref, source.revision, observedAt, input.origin, parsed.items]).slice(7, 39);
  const observations = parsed.items.map(item => catalogObservation(source, item, observedAt, input.origin, batchRef));
  return db.transaction(tx => {
    const receipt = saveObservationBatch(tx, {
      ref: batchRef, source_ref: source.source_ref, source_revision: source.revision,
      observed_at: observedAt, origin: input.origin, observations,
    });
    let candidates = 0;
    for (let i = 0; i < parsed.items.length; i++) {
      const item = parsed.items[i];
      const o = observations[i];
      // Store only normalized public work facts, never the entire HTML,
      // embedded scripts, cookies, response headers or a local file path.
      tx.insert(marketEvidence).values({
        ref: o.source_snapshot_ref, sourceRef: source.source_ref, observedAt,
        payload: { title: item.title, public_url: item.url, source_item_id: item.id, origin: input.origin },
      }).onConflictDoNothing().run();
      // Each imported item refreshes a per-source candidate work mapping so
      // identity review has provenance; same titles never merge across sources.
      if (refreshWorkCandidate(tx, workSubjectRef(source.source_ref, item.id), item.title, o.source_snapshot_ref)) candidates++;
    }
    return { ...receipt, items: observations.length, origin: input.origin, work_candidates_created: candidates,
      limitations: ["Catalog presence is not audience demand, ranking, premiere time or live-source qualification.",
        "Imported works stay candidate mappings until an explicit owner identity review."] };
  }, { behavior: "immediate" });
}

function catalogObservation(source: MarketSource, item: CatalogItem, observedAt: string, origin: MarketObservation["origin"], run: string): MarketObservation {
  const ref = "catalog-obs-" + marketDigest([source.source_ref, source.revision, item.id, observedAt, origin]).slice(7, 39);
  return parseMarketObservation({
    spec: "radar.market_observation.v1", observation_ref: ref,
    source_ref: source.source_ref, source_revision: source.revision, source_item_id: item.id,
    source_snapshot_ref: "evidence-" + ref, observed_at: observedAt, source_published_at: null,
    market: "unknown", market_evidence_refs: [], locale: source.locale,
    format: "unknown", production_method: "unknown", production_evidence_refs: [],
    title: item.title, topics: [], facts: [], evidence_refs: ["evidence-" + ref],
    collection_run_ref: run, origin,
  });
}
