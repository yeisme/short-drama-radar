import type { RadarDb } from "../db/client.ts";
import { marketEvidence } from "../db/schema.ts";
import { isMarketInstant, parseMarketObservation, type MarketObservation, type MarketSource, type MetricFact } from "./domain.ts";
import { marketDigest, MarketStoreError, saveObservationBatch, sourceByRef } from "./repository.ts";
import { refreshWorkCandidate, workSubjectRef } from "./identity.ts";
import { classifyLabels } from "./classification.ts";

export const CATALOG_PAGES: Record<string, string> = {
  hongguo: "https://novelquickapp.com/hongguo",
  reelshort: "https://www.reelshort.com/",
  dramabox: "https://www.dramabox.com/",
};

// Live sampling pages are distinct from identity URLs. Hongguo work links
// live on the public category listing, not the marketing homepage.
export const CATALOG_SAMPLE_PAGES: Record<string, string> = {
  hongguo: "https://novelquickapp.com/category",
};

export interface CatalogItem {
  id: string; title: string; url: string;
  category: string | null; episode_count: number | null;
}
export interface CatalogResult {
  items: CatalogItem[];
  status: "parsed" | "unavailable";
  reason: string | null;
  // Partial failures stay visible: skipped links and missing per-source
  // fields are counted instead of silently disappearing.
  skipped: { foreign_or_unsafe_link: number; no_work_identity: number; title_invalid: number };
  field_coverage: { category: number; episode_count: number };
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

// Episode counts appear as page text such as "全80集", "更新至12集" or
// "80 eps". Only explicit counts are accepted; missing text stays null.
const EPISODE_PATTERNS = [
  /(?:全|更新至|已更新至|已更至)\s*(\d{1,4})\s*集/u,
  /\b(\d{1,4})\s*(?:eps?|episodes?)\b/i,
];

// Split an anchor text into a clean title plus an optional episode count.
function splitTitle(raw: string): { title: string; episode_count: number | null } {
  for (const pattern of EPISODE_PATTERNS) {
    const match = raw.match(pattern);
    if (match) {
      const cleaned = (raw.slice(0, match.index!) + raw.slice(match.index! + match[0].length))
        .replace(/[（(【[·|,，\-–—:：]\s*[）)】\] ]*$/u, "").replace(/\s+/g, " ").trim();
      if (cleaned.length >= 2) return { title: cleaned, episode_count: Number(match[1]) };
    }
  }
  return { title: raw.replace(/\s+/g, " ").trim(), episode_count: null };
}

const CONTROL_CHARS = /[\x00-\x1f\x7f]/u;
const safeLabel = (label: string): string | null => {
  const normalized = label.replace(/\s+/g, " ").trim();
  return normalized.length >= 1 && normalized.length <= 120 && !CONTROL_CHARS.test(normalized) ? normalized : null;
};

// HTMLRewriter is Bun's native parser. It avoids using a regex as an HTML
// parser and ignores scripts; only recognized work links enter observations.
export async function parseCatalog(source: string, content: string, format: "html" | "markdown"): Promise<CatalogResult> {
  if (!CATALOG_PAGES[source]) throw new MarketStoreError("source_unsupported", "No catalog parser is registered for this source.");
  if (typeof content !== "string" || Buffer.byteLength(content) > 2_000_000) throw new MarketStoreError("input_too_large", "Catalog input must not exceed 2 MB.");
  const links: Array<{ href: string; title: string; category: string | null }> = [];
  let category: string | null = null;
  if (format === "html") {
    // Track each anchor independently, including image-only title links.
    // Section headings carry the page's own category label; a link inherits
    // the label of the section it appears in, never a guessed genre.
    let active: { href: string; title: string } | undefined;
    let heading: string | null = null;
    const commitHeading = () => { if (heading !== null) { const label = safeLabel(heading); if (label) category = label; heading = null; } };
    const parser = new HTMLRewriter()
      .on("a", {
        element(el) {
          // A heading ends where the next element starts: commit any pending
          // heading text first so this anchor inherits its own section label.
          commitHeading();
          // Push the same object `active` refers to: text chunks and img alt
          // fallback mutate it until the end tag, and the pushed entry must
          // observe those mutations.
          const entry = { href: el.getAttribute("href") ?? "", title: el.getAttribute("aria-label") ?? "", category };
          active = entry;
          links.push(entry);
          el.onEndTag(() => { active = undefined; });
        },
        text(chunk) { if (active) active.title += chunk.text; },
      })
      .on("a img", { element(el) { if (active && !active.title.trim()) active.title = el.getAttribute("alt") ?? ""; } })
      .on("h2, h3, h4", {
        element() { commitHeading(); heading = ""; },
        text(chunk) { if (heading !== null) heading += chunk.text; },
      });
    await parser.transform(new Response(content)).text();
    commitHeading();
  } else {
    // Supported extraction format is a plain Markdown link. Image wrappers
    // need a text title link elsewhere; no speculative fallback title from ID.
    for (const line of content.split(/\r?\n/)) {
      const headingMatch = line.match(/^#{1,3}\s+(.+)$/);
      if (headingMatch) { const label = safeLabel(headingMatch[1]); if (label) category = label; continue; }
      for (const match of line.matchAll(/(?<!!)\[([^\[\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g)) {
        links.push({ title: match[1], href: match[2], category });
      }
    }
  }
  const skipped = { foreign_or_unsafe_link: 0, no_work_identity: 0, title_invalid: 0 };
  const items = new Map<string, CatalogItem>();
  const hostOf = CATALOG_PAGES[source];
  for (const link of links) {
    const work = identity(source, link.href);
    if (!work) {
      // Distinguish unsafe/foreign targets from same-site links that simply
      // are not work pages (privacy, browse, episode player links).
      let resolved: URL | null = null;
      try { resolved = new URL(link.href, hostOf); } catch { resolved = null; }
      const unsafe = !resolved || resolved.protocol !== "https:" || resolved.host !== new URL(hostOf).host || resolved.username || resolved.password;
      unsafe ? skipped.foreign_or_unsafe_link++ : skipped.no_work_identity++;
      continue;
    }
    const { title, episode_count } = splitTitle(link.title);
    const label = link.category === null ? null : safeLabel(link.category);
    if (title.length < 2 || title.length > 500) { skipped.title_invalid++; continue; }
    const prior = items.get(work.id);
    if (!prior) items.set(work.id, { ...work, title, category: label, episode_count });
    else {
      // Duplicate links to the same work merge missing fields only; the
      // first seen title remains the recorded original title.
      if (!prior.category && label) prior.category = label;
      if (prior.episode_count === null && episode_count !== null) prior.episode_count = episode_count;
    }
    if (items.size > 1000) throw new MarketStoreError("batch_too_large", "Catalog exceeds 1000 works; use a bounded sampling page.");
  }
  if (!items.size) {
    return { items: [], status: "unavailable", reason: "no_parseable_catalog_items", skipped, field_coverage: { category: 0, episode_count: 0 } };
  }
  const values = [...items.values()];
  return {
    items: values, status: "parsed", reason: null, skipped,
    field_coverage: {
      category: values.filter(item => item.category !== null).length,
      episode_count: values.filter(item => item.episode_count !== null).length,
    },
  };
}

export async function importCatalog(db: RadarDb, input: {
  source: string; content: string; format: "html" | "markdown";
  observedAt: string; origin: "manual" | "fixture" | "live";
}) {
  if (input.origin === "live") {
    throw new MarketStoreError("origin_invalid", "Live observations cannot be minted by import-catalog; use radar market observe.");
  }
  return ingestCatalog(db, input);
}

// Shared catalog ingest used by import-catalog (fixture/manual) and observe
// (live or fixture). Callers must already have decided the origin; this
// function never upgrades fixture/manual into live.
export async function ingestCatalog(db: RadarDb, input: {
  source: string; content: string; format: "html" | "markdown";
  observedAt: string; origin: MarketObservation["origin"];
}) {
  const source = sourceByRef(db, input.source);
  if (!source) throw new MarketStoreError("source_not_found", "Run 'radar market init' before importing a catalog.");
  if (!isMarketInstant(input.observedAt)) throw new MarketStoreError("observation_invalid", "Provide the original observation time as a UTC instant.");
  const parsed = await parseCatalog(input.source, input.content, input.format);
  if (parsed.status === "unavailable") throw new MarketStoreError("source_unavailable", "No parseable catalog items; verify the page and parser before importing.");
  // Directory order is not a rank metric. Reordered links represent the
  // same sample unless the adapter has a separately verified ranking basis.
  parsed.items.sort((a, b) => a.id.localeCompare(b.id));
  // The batch fingerprint covers only fields present on the page, so an
  // upgrade that learns new optional fields still replays old batches to
  // the same ref instead of importing them twice.
  const digestItems = parsed.items.map(({ category, episode_count, ...rest }) => ({
    ...rest, ...(category !== null ? { category } : {}), ...(episode_count !== null ? { episode_count } : {}),
  }));
  const observedAt = new Date(input.observedAt).toISOString();
  const batchRef = "catalog-batch-" + marketDigest([source.source_ref, source.revision, observedAt, input.origin, digestItems]).slice(7, 39);
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
        payload: { title: item.title, public_url: item.url, source_item_id: item.id, origin: input.origin,
          ...(item.category !== null ? { category_label: item.category } : {}),
          ...(item.episode_count !== null ? { episode_count: item.episode_count } : {}) },
      }).onConflictDoNothing().run();
      // Each imported item refreshes a per-source candidate work mapping so
      // identity review has provenance; same titles never merge across sources.
      if (refreshWorkCandidate(tx, workSubjectRef(source.source_ref, item.id), item.title, o.source_snapshot_ref)) candidates++;
    }
    return { ...receipt, items: observations.length, origin: input.origin, work_candidates_created: candidates,
      // Per-source field availability is reported, not implied: a missing
      // category or episode count is visible as a lower coverage count.
      field_coverage: parsed.field_coverage, skipped_links: parsed.skipped,
      limitations: ["Catalog presence is not audience demand, ranking, premiere time or live-source qualification.",
        "Imported works stay candidate mappings until an explicit owner identity review.",
        "Category labels come from the source page and stay unknown when the versioned mapping has no entry; episode counts come from explicit page text only."] };
  }, { behavior: "immediate" });
}

function catalogObservation(source: MarketSource, item: CatalogItem, observedAt: string, origin: MarketObservation["origin"], run: string): MarketObservation {
  const ref = "catalog-obs-" + marketDigest([source.source_ref, source.revision, item.id, observedAt, origin]).slice(7, 39);
  // Map the page's own category label through the versioned classification
  // mapping; unmapped labels keep the raw text in evidence and stay unknown.
  const topics = item.category === null ? [] : classifyLabels({ locale: source.locale, labels: [item.category] }).topics;
  // An explicit episode count is a cumulative catalog fact, not a demand
  // metric: it never produces rank, placement or percentage claims.
  const facts: MetricFact[] = item.episode_count === null ? [] : [{
    name: "episode_count", value: item.episode_count, unit: "episodes", basis: "cumulative",
    window: null, definition_version: "catalog-fields.v1", sample_denominator: null,
  }];
  return parseMarketObservation({
    spec: "radar.market_observation.v1", observation_ref: ref,
    source_ref: source.source_ref, source_revision: source.revision, source_item_id: item.id,
    source_snapshot_ref: "evidence-" + ref, observed_at: observedAt, source_published_at: null,
    market: "unknown", market_evidence_refs: [], locale: source.locale,
    format: "unknown", production_method: "unknown", production_evidence_refs: [],
    title: item.title, topics, facts, evidence_refs: ["evidence-" + ref],
    collection_run_ref: run, origin,
  });
}
