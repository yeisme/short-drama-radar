import { desc, eq } from "drizzle-orm";
import type { RadarDb } from "../db/client.ts";
import { marketSettings, marketSources } from "../db/schema.ts";
import { parseMarketSource, type MarketSource } from "./domain.ts";
import { MarketStoreError, saveSource, sourceByRef } from "./repository.ts";

// Seed targets describe intended observation scope, not proven audience
// geography. All start planned; research notes do not promote live readiness.
type SeedRole = "catalog" | "discussion" | "industry";
interface SeedTarget {
  id: string; publisher: string; role: SeedRole; locale: string;
  // Tasks 1.11-1.21: per-source entry findings. Each unadapted target keeps a
  // concrete, dated sampling gap so `source qualify` returns a specific
  // receipt instead of a generic placeholder. Findings restate the entry
  // review recorded in docs/product/global-market-radar.md (2026-09-11
  // research): a store listing or product introduction is identity material,
  // never work-level observation data. Continuous qualification stays with
  // the owner (task 5.4); readiness is only changed by reviewSource.
  samplingScope: string; limitations: string[];
}
const REVIEW_NOTE = "As of the 2026-09-11 entry review no public work-level collection path exists; owner manual import and continuous qualification (task 5.4) remain the accepted paths.";
const targets: SeedTarget[] = [
  { id: "hongguo", publisher: "hongguo", role: "catalog", locale: "zh-CN",
    samplingScope: "Pending source-specific sampling qualification", limitations: ["No verified observation sample or continuous collection evidence."] },
  { id: "hongguo-animation", publisher: "hongguo", role: "catalog", locale: "zh-CN",
    samplingScope: "Pending: animation catalog entry is app-only; no public web work listing exists to fix a sampling scope.",
    limitations: [
      "App store listing verifies product identity only; the introduction page is not work-level observation data.",
      "Animation format must not imply AI production; production_method stays unknown until per-work evidence is provided.",
      REVIEW_NOTE,
    ] },
  { id: "huolong", publisher: "tencent", role: "catalog", locale: "zh-CN",
    samplingScope: "Pending: new-release calendar, catalog and ranking each need a verified work-level entry before a sampling scope is fixed.",
    limitations: [
      "App store listing verifies product identity only; new-release calendar and ranking descriptions are not collection receipts.",
      "New-release, catalog and ranking surfaces each lack a verified public work-level entry point.",
      REVIEW_NOTE,
    ] },
  { id: "douyin", publisher: "douyin-group", role: "discussion", locale: "zh-CN",
    samplingScope: "Pending source-specific sampling qualification", limitations: ["No verified observation sample or continuous collection evidence."] },
  { id: "xiaohongshu", publisher: "xiaohongshu", role: "discussion", locale: "zh-CN",
    samplingScope: "Pending source-specific sampling qualification", limitations: ["No verified observation sample or continuous collection evidence."] },
  { id: "kuaishou", publisher: "kuaishou", role: "discussion", locale: "zh-CN",
    samplingScope: "Pending: discussion sampling must separate work entries from propagation entries; no work-level entry is verified.",
    limitations: [
      "Work entries and propagation entries are not yet separated by a verified entry point.",
      "Login and anti-automation restrictions apply; qualification must not bypass account walls or risk control.",
      REVIEW_NOTE,
    ] },
  { id: "xifan", publisher: "xifan-unverified", role: "catalog", locale: "zh-CN",
    samplingScope: "Pending: no verified work catalog entry; sampling scope is undefined.",
    limitations: [
      "Product identity is verifiable via the store listing, but the store introduction is not work-level observation.",
      "Stable work identity basis and catalog sampling range are unverified.",
      REVIEW_NOTE,
    ] },
  { id: "bilibili", publisher: "bilibili", role: "discussion", locale: "zh-CN",
    samplingScope: "Pending: discussion sampling must separate discussion, reposts, works and metrics; no entry is verified.",
    limitations: [
      "Discussion, reposts, works and metrics are not yet separated by a verified entry point.",
      "Propagation samples must not masquerade as consumption rankings.",
      REVIEW_NOTE,
    ] },
  { id: "reelshort", publisher: "reelshort", role: "catalog", locale: "en",
    samplingScope: "Pending source-specific sampling qualification", limitations: ["No verified observation sample or continuous collection evidence."] },
  { id: "dramabox", publisher: "dramabox", role: "catalog", locale: "en",
    samplingScope: "Pending source-specific sampling qualification", limitations: ["No verified observation sample or continuous collection evidence."] },
  { id: "netshort", publisher: "netshort", role: "catalog", locale: "unknown",
    samplingScope: "Pending: es/pt language catalogs do not establish MX/BR audience markets; work-level sampling scope is undefined.",
    limitations: [
      "Product identity is verifiable; Spanish/Portuguese content must not be mapped to MX/BR audience markets.",
      "Region-level work performance data is unavailable; market stays unknown until work-level evidence.",
      REVIEW_NOTE,
    ] },
  { id: "melolo", publisher: "melolo", role: "catalog", locale: "id",
    samplingScope: "Pending: work fields and Indonesia market evidence must be qualified separately.",
    limitations: [
      "Product identity is verifiable via the Indonesia store listing; store availability is not audience heat.",
      "Work-level fields and Indonesia market evidence are unverified.",
      REVIEW_NOTE,
    ] },
  { id: "dramawave", publisher: "dramawave", role: "catalog", locale: "unknown",
    samplingScope: "Pending: the developer site was not extractable in the 2026-09-11 review; no public alternative is verified.",
    limitations: [
      "Official site extraction failed during the entry review; no public alternative or permission dependency is verified.",
      REVIEW_NOTE,
    ] },
  { id: "pinedrama", publisher: "douyin-group", role: "catalog", locale: "unknown",
    samplingScope: "Pending: publisher group, work and region bases each require independent verification.",
    limitations: [
      "Product identity is verifiable via the Indonesia store listing.",
      "Publisher-group declaration (douyin-group) still requires independent verification; an independent entry point never counts as independent corroboration.",
      REVIEW_NOTE,
    ] },
  { id: "kukutv", publisher: "kukutv", role: "catalog", locale: "hi",
    samplingScope: "Pending: local language, work data and India market basis each require separate verification.",
    limitations: [
      "Product identity is verifiable via the India store listing; App introduction is not trend data.",
      "Local-language works, work-level data and India market evidence are unverified.",
      REVIEW_NOTE,
    ] },
  { id: "quicktv", publisher: "quicktv", role: "catalog", locale: "hi",
    samplingScope: "Pending: stable IDs, topics and the India sampling range are unverified; denominators stay per-source.",
    limitations: [
      "Product identity is verifiable via the India store listing.",
      "Stable work identity, topic basis and sampling range are unverified; denominators stay separate from other sources.",
      REVIEW_NOTE,
    ] },
  { id: "dataeye", publisher: "dataeye", role: "industry", locale: "zh-CN",
    samplingScope: "Pending source-specific sampling qualification", limitations: ["No verified observation sample or continuous collection evidence."] },
  { id: "sensortower", publisher: "sensortower", role: "industry", locale: "en",
    samplingScope: "Pending source-specific sampling qualification", limitations: ["No verified observation sample or continuous collection evidence."] },
];

export function seedSources(): MarketSource[] {
  return targets.map(({ id, publisher, role, locale, samplingScope, limitations }) => ({
    spec: "radar.market_source.v1",
    source_ref: id, revision: 1, platform: id, role,
    publisher_group: publisher, official_identity_evidence: [],
    market_scope: ["unknown"], locale, collection_method: "public_page",
    metric_definitions: [], sampling_scope: samplingScope,
    freshness_budget: role === "industry" ? null : 26 * 3600,
    readiness: "planned", limitations,
  }));
}

export function listSources(db: RadarDb): MarketSource[] {
  const heads = new Map<string, MarketSource>();
  for (const row of db.select().from(marketSources).orderBy(marketSources.ref, desc(marketSources.revision)).all()) {
    if (!heads.has(row.ref)) heads.set(row.ref, row.payload);
  }
  return [...heads.values()];
}

export function initializeMarket(db: RadarDb): { sources: MarketSource[]; settings: ReturnType<typeof readSettings> } {
  return db.transaction(tx => {
    for (const source of seedSources()) {
      if (!sourceByRef(tx, source.source_ref)) saveSource(tx, source, 0);
    }
    tx.insert(marketSettings).values({
      ref: "local", revision: 1, payload: { timezone: "UTC", blocked_topics: [] },
    }).onConflictDoNothing().run();
    return { sources: listSources(tx), settings: readSettings(tx) };
  }, { behavior: "immediate" });
}

export function readSettings(db: RadarDb) {
  const row = db.select().from(marketSettings).where(eq(marketSettings.ref, "local")).get();
  if (!row) throw new MarketStoreError("market_required", "Run 'radar market init' first.");
  return { revision: row.revision, ...row.payload };
}

export function updateSettings(db: RadarDb, expectedRevision: number, patch: { timezone?: string; blocked_topics?: string[] }) {
  if (patch.timezone !== undefined) {
    try { new Intl.DateTimeFormat("en", { timeZone: patch.timezone }); }
    catch { throw new MarketStoreError("config_invalid", "timezone must be a supported IANA timezone."); }
  }
  if (patch.blocked_topics !== undefined && (
    !Array.isArray(patch.blocked_topics) || patch.blocked_topics.length > 100 ||
    patch.blocked_topics.some(t => typeof t !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(t))
  )) throw new MarketStoreError("config_invalid", "blocked_topics must contain at most 100 safe topic refs.");
  return db.transaction(tx => {
    const current = readSettings(tx);
    if (current.revision !== expectedRevision) throw new MarketStoreError("state_conflict", "Market settings changed; read settings before updating.");
    const payload = { timezone: patch.timezone ?? current.timezone, blocked_topics: patch.blocked_topics ?? current.blocked_topics };
    tx.update(marketSettings).set({ revision: current.revision + 1, payload }).where(eq(marketSettings.ref, "local")).run();
    return { revision: current.revision + 1, ...payload };
  }, { behavior: "immediate" });
}

export function updateSource(db: RadarDb, ref: string, expectedRevision: number, patch: Partial<MarketSource>) {
  const allowed = new Set(["sampling_scope", "freshness_budget", "locale", "market_scope", "limitations"]);
  if (Object.keys(patch).some(key => !allowed.has(key))) throw new MarketStoreError("source_update_invalid", "Only sampling scope, freshness, locale, markets and limitations may be configured.");
  const current = sourceByRef(db, ref);
  if (!current) throw new MarketStoreError("source_not_found", "Source not registered; run 'radar market init'.");
  // Any sampling/config change invalidates collection qualification; old
  // revisions remain available to historical observations.
  const next = parseMarketSource({
    ...current, ...patch, revision: expectedRevision + 1,
    readiness: current.official_identity_evidence.length ? "identity_verified" : "planned",
  });
  return saveSource(db, next, expectedRevision);
}

// Discovery entry for regions without a seeded source (design: "平台由
// Agent 提供候选"). Registration only writes a planned research candidate;
// it never installs an adapter, backend or schedule, and readiness stays
// planned until the qualification service promotes it.
export function registerSourceCandidate(db: RadarDb, input: {
  source_ref: string; publisher_group: string; locale: string; markets: string[];
  role?: "catalog" | "discussion" | "industry"; note?: string;
}) {
  const refPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
  const note = input.note?.replace(/\s+/g, " ").trim() ?? "";
  if (!refPattern.test(input.source_ref) || !refPattern.test(input.publisher_group) ||
    !Array.isArray(input.markets) || input.markets.length < 1 || input.markets.length > 10 ||
    input.markets.some(m => typeof m !== "string" || !/^(?:global|unknown|[A-Z]{2})$/.test(m)) ||
    note.length > 500 || (input.role !== undefined && !["catalog", "discussion", "industry"].includes(input.role)) ||
    (input.locale !== "unknown" && (typeof input.locale !== "string" || input.locale.length > 60 ||
      Intl.getCanonicalLocales(input.locale).length !== 1))) {
    throw new MarketStoreError("candidate_invalid",
      "Provide a source ref, publisher group, locale, 1-10 declared markets (global/unknown/ISO code) and an optional short note.");
  }
  return db.transaction(tx => {
    const prior = sourceByRef(tx, input.source_ref);
    if (prior) {
      // Registration is declarative and idempotent: the same candidate
      // replays to the same descriptor, conflicting parameters are refused
      // instead of silently overwriting an existing source.
      const same = prior.publisher_group === input.publisher_group && prior.locale === input.locale &&
        prior.role === (input.role ?? "catalog") && JSON.stringify(prior.market_scope) === JSON.stringify(input.markets);
      if (!same) throw new MarketStoreError("state_conflict", "Source ref already registered with different parameters; register a distinct ref or use source set.");
      return { source: prior, reused: true };
    }
    const source = parseMarketSource({
      spec: "radar.market_source.v1", source_ref: input.source_ref, revision: 1,
      platform: input.source_ref, role: input.role ?? "catalog", publisher_group: input.publisher_group,
      official_identity_evidence: [], market_scope: input.markets as MarketSource["market_scope"],
      locale: input.locale, collection_method: "public_page", metric_definitions: [],
      sampling_scope: "Research candidate; sampling scope not yet qualified",
      freshness_budget: (input.role ?? "catalog") === "industry" ? null : 26 * 3600,
      readiness: "planned",
      limitations: [
        "Agent-registered research candidate; no observation, identity or qualification evidence.",
        "Registration does not install an adapter, backend or schedule; readiness stays planned until qualification.",
        ...(note ? [note] : []),
      ],
    });
    saveSource(tx, source, 0);
    return { source, reused: false };
  }, { behavior: "immediate" });
}
