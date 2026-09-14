import { desc, eq } from "drizzle-orm";
import type { RadarDb } from "../db/client.ts";
import { marketSettings, marketSources } from "../db/schema.ts";
import { parseMarketSource, type MarketSource } from "./domain.ts";
import { MarketStoreError, saveSource, sourceByRef } from "./repository.ts";

// Seed targets describe intended observation scope, not proven audience
// geography. All start planned; research notes do not promote live readiness.
const targets = [
  ["hongguo", "hongguo", "catalog", "zh-CN"],
  ["hongguo-animation", "hongguo", "catalog", "zh-CN"],
  ["huolong", "tencent", "catalog", "zh-CN"],
  ["douyin", "douyin-group", "discussion", "zh-CN"],
  ["xiaohongshu", "xiaohongshu", "discussion", "zh-CN"],
  ["kuaishou", "kuaishou", "discussion", "zh-CN"],
  ["xifan", "xifan-unverified", "catalog", "zh-CN"],
  ["bilibili", "bilibili", "discussion", "zh-CN"],
  ["reelshort", "reelshort", "catalog", "en"],
  ["dramabox", "dramabox", "catalog", "en"],
  ["netshort", "netshort", "catalog", "unknown"],
  ["melolo", "melolo", "catalog", "id"],
  ["dramawave", "dramawave", "catalog", "unknown"],
  ["pinedrama", "douyin-group", "catalog", "unknown"],
  ["kukutv", "kukutv", "catalog", "hi"],
  ["quicktv", "quicktv", "catalog", "hi"],
  ["dataeye", "dataeye", "industry", "zh-CN"],
  ["sensortower", "sensortower", "industry", "en"],
] as const;

export function seedSources(): MarketSource[] {
  return targets.map(([id, publisher, role, locale]) => ({
    spec: "radar.market_source.v1",
    source_ref: id, revision: 1, platform: id, role,
    publisher_group: publisher, official_identity_evidence: [],
    market_scope: ["unknown"], locale, collection_method: "public_page",
    metric_definitions: [], sampling_scope: "Pending source-specific sampling qualification",
    freshness_budget: role === "industry" ? null : 26 * 3600,
    readiness: "planned", limitations: ["No verified observation sample or continuous collection evidence."],
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
