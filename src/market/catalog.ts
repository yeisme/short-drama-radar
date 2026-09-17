import type { RadarDb } from "../db/client.ts";
import { marketEvidence } from "../db/schema.ts";
import { isMarketInstant, parseMarketObservation, type MarketObservation, type MarketSource, type MetricFact } from "./domain.ts";
import { marketDigest, MarketStoreError, saveObservationBatch, sourceByRef } from "./repository.ts";
import { refreshWorkCandidate, workSubjectRef } from "./identity.ts";
import { classifyLabels } from "./classification.ts";
import { GENERIC_CATALOG_PARSER_VERSION, persistObservationQuality } from "./quality.ts";

export const CATALOG_PAGES: Record<string, string> = {
  hongguo: "https://novelquickapp.com/hongguo",
  reelshort: "https://www.reelshort.com/",
  "reelshort-ja": "https://www.reelshort.com/ja",
  "reelshort-ko": "https://www.reelshort.com/ko",
  dramabox: "https://www.dramabox.com/",
};

// Live sampling pages are distinct from identity URLs. Hongguo work links
// live on the public category listing, not the marketing homepage.
export const CATALOG_SAMPLE_PAGES: Record<string, string> = {
  hongguo: "https://novelquickapp.com/category",
  "reelshort-ja": "https://www.reelshort.com/ja",
  "reelshort-ko": "https://www.reelshort.com/ko",
};

export const LOCALIZED_REELSHORT_PARSER_VERSION = "reelshort-localized-links.v1";
const localizedLanguage = (source: string) => source === "reelshort-ja" ? "ja" : source === "reelshort-ko" ? "ko" : null;

export interface CatalogItem {
  id: string; title: string; url: string;
  category: string | null; episode_count: number | null;
  // Every page-own genre label bound to the work (anchor tag spans or the
  // inherited section heading), deduped; category stays the primary label.
  labels: string[];
}
export interface CatalogResult {
  items: CatalogItem[];
  status: "parsed" | "unavailable";
  reason: string | null;
  // Partial failures stay visible: skipped links and missing per-source
  // fields are counted instead of silently disappearing.
  skipped: { foreign_or_unsafe_link: number; no_work_identity: number; title_invalid: number };
  // Why links were skipped, bucketed by URL shape only; full URLs are never
  // echoed into receipts or logs.
  skip_attribution: { foreign_or_unsafe_link: Record<string, number>; no_work_identity: Record<string, number> };
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
  } else if (localizedLanguage(source)) {
    const language = localizedLanguage(source)!;
    id = url.pathname.match(new RegExp(`^/(?:${language}/)?movie/[^/]+-([a-f0-9]{24})/?$`, "i"))?.[1];
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

// A paragraph that is nothing but an episode phrase ("全78集") is the card's
// episode field, not part of the title.
function episodeOnly(text: string): number | null {
  for (const pattern of EPISODE_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      const rest = (text.slice(0, match.index!) + text.slice(match.index! + match[0].length))
        .replace(/[（(【[·|,，\-–—:：\s）)】\]]/gu, "");
      if (!rest) return Number(match[1]);
    }
  }
  return null;
}

export const HONGGUO_ANCHOR_LAYOUT_VERSION = "hongguo-anchor-layout.v1";
const HONGGUO_ANCHOR_LABEL_LIMIT = 8;

interface AnchorStructure {
  imgAlt: string | null;
  paragraphs: string[];
  spans: string[];
}

// hongguo-anchor-layout.v1: a hongguo work card anchor repeats the title
// twice (cover img alt and a title <p>), carries an explicit episode <p> and
// one <span> per page genre label. The layout only fires on that exact
// structure; anything else returns null so the caller keeps the plain-text
// title with no labels — never a half-split or a guessed genre.
//
// The live page pads visible text with NUL bytes (e.g. a tag span arrives as
// "爱\0\0情") and may split the doubled title across whitespace; both are
// page transport noise, so this rule strips control characters before the
// usual label validation and compares the doubled title whitespace-free.
const stripPageNoise = (text: string): string => text.replace(/[\x00-\x1f\x7f]/gu, "");

function splitHongguoAnchor(structure: AnchorStructure): { title: string; episode_count: number | null; labels: string[] } | null {
  let episode_count: number | null = null;
  const titles: string[] = [];
  for (const raw of structure.paragraphs) {
    const paragraph = stripPageNoise(raw).replace(/\s+/g, " ").trim();
    if (!paragraph) continue;
    const episode = episodeOnly(paragraph);
    if (episode !== null) { episode_count ??= episode; continue; }
    const split = splitTitle(paragraph);
    if (split.episode_count !== null) episode_count ??= split.episode_count;
    if (!titles.includes(split.title)) titles.push(split.title);
  }
  if (titles.length !== 1 || titles[0].length < 2) return null;
  const imgAlt = stripPageNoise(structure.imgAlt ?? "").replace(/\s+/g, " ").trim();
  // The layout is defined by the doubled title: the cover alt must exist and
  // agree with the title <p> up to whitespace. A missing or conflicting alt
  // means the structure was misread and the raw text stays authoritative.
  if (!imgAlt || imgAlt.replace(/\s+/g, "") !== titles[0].replace(/\s+/g, "")) return null;
  const labels: string[] = [];
  for (const raw of structure.spans) {
    const label = safeLabel(stripPageNoise(raw));
    if (label && !labels.includes(label)) labels.push(label);
    if (labels.length >= HONGGUO_ANCHOR_LABEL_LIMIT) break;
  }
  return { title: titles[0], episode_count, labels };
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
  const links: Array<{ href: string; title: string; category: string | null } & AnchorStructure> = [];
  let category: string | null = null;
  if (format === "html") {
    // Track each anchor independently, including image-only title links.
    // Section headings carry the page's own category label; a link inherits
    // the label of the section it appears in, never a guessed genre.
    let active: { href: string; title: string; category: string | null } & AnchorStructure | undefined;
    let activeParagraph = -1;
    let activeSpan = -1;
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
          const entry = { href: el.getAttribute("href") ?? "", title: el.getAttribute("aria-label") ?? "", category,
            imgAlt: null, paragraphs: [] as string[], spans: [] as string[] };
          active = entry;
          activeParagraph = -1;
          activeSpan = -1;
          links.push(entry);
          el.onEndTag(() => { active = undefined; });
        },
        text(chunk) { if (active) active.title += chunk.text; },
      })
      .on("a img", { element(el) {
        if (active) {
          const alt = el.getAttribute("alt") ?? "";
          if (!active.title.trim()) active.title = alt;
          if (active.imgAlt === null && alt.trim()) active.imgAlt = alt;
        }
      } })
      // Anchor-internal paragraphs and spans are the hongguo work card
      // structure (episode <p>, title <p>, one <span> per genre label). They
      // are collected for every source but only consumed by the hongguo
      // anchor layout rule.
      .on("a p", {
        element() { if (active) { active.paragraphs.push(""); activeParagraph = active.paragraphs.length - 1; } },
        text(chunk) { if (active && activeParagraph >= 0 && activeParagraph < active.paragraphs.length) active.paragraphs[activeParagraph] += chunk.text; },
      })
      .on("a span", {
        element() { if (active) { active.spans.push(""); activeSpan = active.spans.length - 1; } },
        text(chunk) { if (active && activeSpan >= 0 && activeSpan < active.spans.length) active.spans[activeSpan] += chunk.text; },
      })
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
        links.push({ title: match[1], href: match[2], category, imgAlt: null, paragraphs: [], spans: [] });
      }
    }
  }
  const skipped = { foreign_or_unsafe_link: 0, no_work_identity: 0, title_invalid: 0 };
  const attribution = { foreign_or_unsafe_link: new Map<string, number>(), no_work_identity: new Map<string, number>() };
  const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
  const items = new Map<string, CatalogItem>();
  const hostOf = CATALOG_PAGES[source];
  for (const link of links) {
    const work = identity(source, link.href);
    if (!work) {
      // Distinguish unsafe/foreign targets from same-site links that simply
      // are not work pages (privacy, browse, episode player links), and keep
      // the skip reason explainable by URL shape without echoing full URLs.
      let resolved: URL | null = null;
      try { resolved = new URL(link.href, hostOf); } catch { resolved = null; }
      const unsafe = !resolved || resolved.protocol !== "https:" || resolved.host !== new URL(hostOf).host || resolved.username || resolved.password;
      if (unsafe) {
        skipped.foreign_or_unsafe_link++;
        bump(attribution.foreign_or_unsafe_link, !resolved ? "unparseable_url"
          : resolved.username || resolved.password ? "url_credentials"
          : resolved.protocol !== "https:" ? "non_https_protocol" : "foreign_host");
      } else if (resolved) {
        skipped.no_work_identity++;
        const path = resolved.pathname;
        bump(attribution.no_work_identity, path === "/" ? "home_or_navigation"
          : path.startsWith("/category") ? (resolved.searchParams.has("page") ? "pagination" : "category_or_genre_filter")
          : path.startsWith("/rank") ? "ranking_page" : "other_non_work_page");
      }
      continue;
    }
    let title: string;
    let episode_count: number | null;
    let anchorLabels: string[] = [];
    const layout = source === "hongguo" && format === "html" ? splitHongguoAnchor(link) : null;
    if (layout) ({ title, episode_count } = layout, anchorLabels = layout.labels);
    else if (localizedLanguage(source)) {
      // Only strip the observed Japanese navigation suffix, never infer a
      // title from a plot, translation, URL slug or localized category.
      title = link.title.replace(/\s+/g, " ").trim();
      if (source === "reelshort-ja") title = title.replace(/\s+全シリーズ$/u, "");
      episode_count = null;
    } else ({ title, episode_count } = splitTitle(link.title));
    const headingLabel = localizedLanguage(source) || link.category === null ? null : safeLabel(link.category);
    // Anchor-own labels stay closer to the work than a section heading; when
    // both exist the anchor labels win, and with neither the genre stays null.
    const labels = anchorLabels.length > 0 ? anchorLabels : headingLabel ? [headingLabel] : [];
    if (title.length < 2 || title.length > 500) { skipped.title_invalid++; continue; }
    const prior = items.get(work.id);
    if (!prior) items.set(work.id, { ...work, title, category: labels[0] ?? null, labels, episode_count });
    else {
      // Duplicate links to the same work merge missing fields only; the
      // first seen title remains the recorded original title.
      if (!prior.category && labels[0]) prior.category = labels[0];
      if (prior.labels.length === 0 && labels.length > 0) prior.labels = labels;
      if (prior.episode_count === null && episode_count !== null) prior.episode_count = episode_count;
    }
    if (items.size > 1000) throw new MarketStoreError("batch_too_large", "Catalog exceeds 1000 works; use a bounded sampling page.");
  }
  const skip_attribution = {
    foreign_or_unsafe_link: Object.fromEntries([...attribution.foreign_or_unsafe_link].sort((a, b) => b[1] - a[1])),
    no_work_identity: Object.fromEntries([...attribution.no_work_identity].sort((a, b) => b[1] - a[1])),
  };
  if (!items.size) {
    return { items: [], status: "unavailable", reason: "no_parseable_catalog_items", skipped, skip_attribution, field_coverage: { category: 0, episode_count: 0 } };
  }
  const values = [...items.values()];
  return {
    items: values, status: "parsed", reason: null, skipped, skip_attribution,
    field_coverage: {
      category: values.filter(item => item.labels.length > 0).length,
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
  const language = localizedLanguage(input.source);
  if (language && (source.locale.split("-")[0] !== language || source.publisher_group !== "reelshort")) {
    throw new MarketStoreError("source_descriptor_mismatch", "Localized ReelShort sampling requires its matching language and publisher group reelshort.");
  }
  const parsed = await parseCatalog(input.source, input.content, input.format);
  if (parsed.status === "unavailable") throw new MarketStoreError("source_unavailable", "No parseable catalog items; verify the page and parser before importing.");
  // Directory order is not a rank metric. Reordered links represent the
  // same sample unless the adapter has a separately verified ranking basis.
  parsed.items.sort((a, b) => a.id.localeCompare(b.id));
  // The batch fingerprint covers only fields present on the page, so an
  // upgrade that learns new optional fields still replays old batches to
  // the same ref instead of importing them twice.
  const digestItems = parsed.items.map(({ category, episode_count, labels, ...rest }) => ({
    ...rest, ...(category !== null ? { category } : {}), ...(episode_count !== null ? { episode_count } : {}),
    ...(labels.length > 0 ? { labels } : {}),
  }));
  const observedAt = new Date(input.observedAt).toISOString();
  const batchRef = "catalog-batch-" + marketDigest([source.source_ref, source.revision, observedAt, input.origin, digestItems]).slice(7, 39);
  const observations = parsed.items.map(item => catalogObservation(source, item, observedAt, input.origin, batchRef));
  return db.transaction(tx => {
    const receipt = saveObservationBatch(tx, {
      ref: batchRef, source_ref: source.source_ref, source_revision: source.revision,
      observed_at: observedAt, origin: input.origin, observations,
    });
    // Quality is written in the same transaction as a new batch. Replays
    // never backfill historical batches that predate the quality contract.
    if (!receipt.reused) {
      persistObservationQuality(tx, {
        batch_ref: batchRef, source, observed_at: observedAt, origin: input.origin,
        parser_version: source.source_ref === "hongguo" ? HONGGUO_ANCHOR_LAYOUT_VERSION : localizedLanguage(source.source_ref) ? LOCALIZED_REELSHORT_PARSER_VERSION : GENERIC_CATALOG_PARSER_VERSION,
        items: observations.length,
        field_coverage: {
          title: { present: observations.length, total: observations.length },
          category: { present: parsed.field_coverage.category, total: observations.length },
          episode_count: { present: parsed.field_coverage.episode_count, total: observations.length },
        },
        skipped: parsed.skipped,
      });
    }
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
          ...(item.labels.length > 0 ? { category_labels: item.labels } : {}),
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
        "Category labels come from the source page and stay unknown when the versioned mapping has no entry; episode counts come from explicit page text only.",
        ...(parsed.items.some(item => item.labels.length > 0)
          ? [`Genre labels come from the page's own structure (${HONGGUO_ANCHOR_LAYOUT_VERSION} work anchors or inherited section headings), never from keyword guesses over titles or plots.`]
          : []),
        ...(parsed.skipped.no_work_identity > 0
          ? [localizedLanguage(source.source_ref)
            ? `Skipped same-host links outside this localized work URL contract (${formatAttribution(parsed.skip_attribution.no_work_identity)}); other language routes and player pages are excluded.`
            : `Skipped same-host links were non-work pages (${formatAttribution(parsed.skip_attribution.no_work_identity)}); no work link was rejected.`]
          : []),
        ...(parsed.skipped.foreign_or_unsafe_link > 0
          ? [`Skipped links failed the catalog safety boundary (${formatAttribution(parsed.skip_attribution.foreign_or_unsafe_link)}); full URLs are never echoed.`]
          : [])] };
  }, { behavior: "immediate" });
}

function formatAttribution(buckets: Record<string, number>): string {
  return Object.entries(buckets).map(([kind, count]) => `${kind} x${count}`).join(", ");
}

function catalogObservation(source: MarketSource, item: CatalogItem, observedAt: string, origin: MarketObservation["origin"], run: string): MarketObservation {
  const ref = "catalog-obs-" + marketDigest([source.source_ref, source.revision, item.id, observedAt, origin]).slice(7, 39);
  // Map the page's own genre labels through the versioned classification
  // mapping; unmapped labels keep the raw text in evidence and stay unknown.
  const topics = item.labels.length === 0 ? [] : classifyLabels({ locale: source.locale, labels: item.labels }).topics;
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
