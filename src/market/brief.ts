import { and, desc, eq, gte, lt } from "drizzle-orm";
import type { RadarDb } from "../db/client.ts";
import { marketBriefs, marketSignals } from "../db/schema.ts";
import { isMarketInstant } from "./domain.ts";
import { marketDigest, MarketStoreError } from "./repository.ts";
import { marketReadPolicy } from "./policy.ts";
import { listSources, readSettings } from "./sources.ts";
import { sourceGaps } from "./qualification.ts";
import { compareMarketSignalOrder, MARKET_SIGNAL_ORDER_VERSION, type MarketSignal } from "./signals.ts";

export interface MarketBrief {
  spec: "radar.market_brief.v1";
  brief_ref: string;
  digest: string;
  supersedes: string | null;
  generated_at: string;
  timezone: string;
  window: { start: string; end: string };
  builder_version: string;
  order_version: string;
  signals: MarketSignal[];
  coverage: ReturnType<typeof sourceGaps>;
  status: "ready" | "empty" | "degraded";
  limitations: string[];
}

export function buildMarketBrief(db: RadarDb, start: string, end: string, now = new Date()) {
  if (!isMarketInstant(start) || !isMarketInstant(end) || Date.parse(start) >= Date.parse(end) ||
    !Number.isFinite(now.getTime()) || Date.parse(end) > now.getTime()) {
    throw new MarketStoreError("window_invalid", "Use a completed, increasing UTC brief window.");
  }
  return db.transaction(tx => {
    const settings = readSettings(tx);
    const window = { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
    const rows = tx.select().from(marketSignals).where(and(
      gte(marketSignals.observedAt, window.start), lt(marketSignals.observedAt, window.end),
    )).orderBy(desc(marketSignals.observedAt), desc(marketSignals.revision), marketSignals.ref).all();
    const heads = new Map<string, MarketSignal>();
    for (const row of rows) if (!heads.has(row.ref)) heads.set(row.ref, row.payload);
    // Versioned deterministic order (design §4): corrections, confirmed
    // claims, source priority, independent evidence groups, recency, ref.
    const roles = new Map(listSources(tx).map(source => [source.source_ref, source.role] as const));
    const signals = [...heads.values()].sort((a, b) => compareMarketSignalOrder(a, b, ref => roles.get(ref)));
    // Coverage uses the publication boundary, not the wall clock at replay.
    // Otherwise an identical rebuild would invent a new edition every second.
    const coverage = sourceGaps(tx, new Date(window.end));
    const limitations = ["Source qualification is incomplete; coverage does not represent the entire market."];
    if (signals.some(s => s.origin !== "live")) limitations.push("This edition contains fixture or manually imported observations.");
    // ready requires every signal to come from live collection of qualified
    // sources; fixture/manual imports or unqualified sources stay degraded.
    const readiness = new Map(listSources(tx).map(source => [source.source_ref, source.readiness] as const));
    const status = !signals.length ? "empty" as const
      : signals.every(s => s.origin === "live" && readiness.get(s.source_ref) === "qualified") ? "ready" as const
        : "degraded" as const;
    const content = {
      spec: "radar.market_brief.v1" as const, timezone: settings.timezone,
      window, builder_version: "market-brief-builder.v1", order_version: MARKET_SIGNAL_ORDER_VERSION,
      signals, coverage, status, limitations,
    };
    // The input fingerprint excludes supersedes: the brief identity is the
    // window content, so an identical replay reuses the frozen edition while
    // late data or corrections mint a successor linked to its predecessor.
    const digest = marketDigest(content), ref = "market-brief-" + digest.slice(7, 39);
    const prior = tx.select().from(marketBriefs).where(eq(marketBriefs.ref, ref)).get();
    if (prior) return { brief: prior.payload, reused: true };
    const superseded = tx.select().from(marketBriefs).where(eq(marketBriefs.windowEnd, window.end))
      .orderBy(desc(marketBriefs.generatedAt), marketBriefs.ref).all()
      .filter(row => row.payload.window.start === window.start && row.ref !== ref)[0] ?? null;
    const brief: MarketBrief = { ...content, brief_ref: ref, digest,
      supersedes: superseded?.ref ?? null, generated_at: now.toISOString() };
    tx.insert(marketBriefs).values({ ref, windowEnd: window.end, generatedAt: brief.generated_at, payload: brief }).run();
    return { brief, reused: false };
  }, { behavior: "immediate" });
}

export function marketBriefByRef(db: RadarDb, ref: string): MarketBrief | null {
  const query = db.select().from(marketBriefs);
  return (ref === "latest"
    ? query.orderBy(desc(marketBriefs.windowEnd), desc(marketBriefs.generatedAt), marketBriefs.ref).limit(1).get()
    : query.where(eq(marketBriefs.ref, ref)).get())?.payload ?? null;
}

export function readMarketBrief(db: RadarDb, ref = "latest") {
  const brief = marketBriefByRef(db, ref);
  if (!brief) throw new MarketStoreError("brief_not_found", "No completed market brief exists for this ref.");
  const policy = marketReadPolicy(db);
  const visible = brief.signals.filter(s => !policy.blocked_topics.length ||
    (s.topics.length > 0 && !s.topics.some(topic => policy.blocked_topics.includes(topic))));
  const corrections = visible.filter(s => s.claim_kind === "correction");
  const confirmed = visible.filter(s => s.assertion_level === "confirmed" && s.claim_kind !== "correction");
  const watching = visible.filter(s => s.assertion_level !== "confirmed" && s.claim_kind !== "correction");
  const topicCounts = new Map<string, number>();
  const main: MarketSignal[] = [];
  const add = (signal: MarketSignal) => {
    if (main.some(s => s.signal_ref === signal.signal_ref)) return;
    const topic = signal.topics[0];
    if (signal.claim_kind !== "correction" && topic && (topicCounts.get(topic) ?? 0) >= 2) return;
    if (main.length >= 5) return;
    main.push(signal);
    if (topic) topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1);
  };
  const domestic = confirmed.find(s => s.market === "CN");
  const overseas = confirmed.find(s => /^[A-Z]{2}$/.test(s.market) && s.market !== "CN");
  corrections.forEach(add);
  if (domestic) add(domestic);
  if (overseas) add(overseas);
  confirmed.forEach(add);
  return {
    spec: brief.spec, brief_ref: brief.brief_ref, digest: brief.digest,
    supersedes: brief.supersedes, generated_at: brief.generated_at,
    timezone: brief.timezone, window: brief.window,
    status: brief.status, order_version: brief.order_version, policy_revision: policy.policy_revision,
    main, watching: watching.slice(0, 2),
    correction_count: corrections.length,
    correction_refs: corrections.map(s => ({ ref: s.signal_ref, revision: s.revision })),
    visible_signal_refs: visible.map(s => ({ ref: s.signal_ref, revision: s.revision })),
    remaining: Math.max(0, visible.length - main.length - Math.min(2, watching.length)),
    filtered: visible.length !== brief.signals.length,
    coverage: brief.coverage, limitations: brief.limitations,
  };
}
