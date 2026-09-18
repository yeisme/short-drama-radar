import { and, desc, eq, gte, lt } from "drizzle-orm";
import type { RadarDb } from "../db/client.ts";
import { marketBatches, marketReaders, marketSignals, marketWatches, marketWatchReceipts } from "../db/schema.ts";
import { isMarketInstant, OBSERVATION_MARKETS } from "./domain.ts";
import { readReader } from "./reader.ts";
import { marketDigest, MarketStoreError } from "./repository.ts";
import { listSources } from "./sources.ts";
import { marketReadPolicy } from "./policy.ts";

export interface MarketWatch {
  spec: "radar.market_watch.v1"; watch_ref: string; reader_ref: "local";
  target_kind: "topic" | "work" | "platform" | "market"; target_ref: string;
  state: "active" | "paused" | "removed"; revision: number;
  /** Start of the most recent pause; kept after resume so the pause window stays queryable. */
  last_paused_at: string | null;
}
export interface WatchReceipt {
  spec: "radar.market_receipt.v1"; idempotency_key: string; payload_digest: string;
  action: "add" | "pause" | "resume" | "remove"; reader_revision: number;
  outcome: "success"; watch: MarketWatch;
}
function storedWatchReceipt(db: RadarDb, key: string) {
  return db.select().from(marketWatchReceipts).where(eq(marketWatchReceipts.key, key)).get()?.payload ?? null;
}
function watchPolicy(db: RadarDb) {
  const policy = marketReadPolicy(db);
  const heads = new Map<string, typeof marketSignals.$inferSelect>();
  // Use current signal revisions, not an arbitrary historical classification.
  if (policy.blocked_topics.length) for (const row of db.select().from(marketSignals).orderBy(desc(marketSignals.revision)).all()) {
    if (!heads.has(row.ref)) heads.set(row.ref, row);
  }
  return (watch: Pick<MarketWatch, "target_kind" | "target_ref">) => {
    if (!policy.blocked_topics.length) return true;
    if (watch.target_kind === "topic") return !policy.blocked_topics.includes(watch.target_ref);
    if (watch.target_kind !== "work") return true;
    const signals = [...heads.values()].filter(row => row.payload.subject_ref === watch.target_ref);
    return signals.length > 0 && signals.every(row => row.payload.topics.length > 0 &&
      !row.payload.topics.some(topic => policy.blocked_topics.includes(topic)));
  };
}
function assertWatchReadable(db: RadarDb, watch: MarketWatch) {
  if (!watchPolicy(db)(watch)) throw new MarketStoreError("content_blocked", "Watch content is blocked or unclassified under the current policy.");
}
export function watchReceipt(db: RadarDb, key: string) {
  const receipt = storedWatchReceipt(db, key);
  if (receipt) assertWatchReadable(db, receipt.watch);
  return receipt;
}
export function listWatches(db: RadarDb) {
  const readable = watchPolicy(db);
  return db.select().from(marketWatches).orderBy(marketWatches.ref).all()
    .map(r => normalizeWatch(r.payload)).filter(readable);
}

// Rows written before last_paused_at existed deserialize without it.
function normalizeWatch(watch: MarketWatch): MarketWatch {
  return { ...watch, last_paused_at: watch.last_paused_at ?? null };
}
export function mutateWatch(db: RadarDb, input: {
  action: WatchReceipt["action"]; key: string; revision: number; policy_revision: string;
  kind?: MarketWatch["target_kind"]; target?: string; watch?: string; now?: Date;
}): WatchReceipt {
  const safe = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(v);
  if (!safe(input.key) || !Number.isSafeInteger(input.revision) || input.revision < 1 ||
    !["add", "pause", "resume", "remove"].includes(input.action)) throw new MarketStoreError("watch_invalid", "Invalid watch action or revision.");
  const digest = marketDigest(input);
  return db.transaction(tx => {
    const previous = storedWatchReceipt(tx, input.key);
    if (previous) {
      if (previous.payload_digest !== digest) throw new MarketStoreError("idempotency_conflict", "Watch key was used with different parameters.");
      assertWatchReadable(tx, previous.watch);
      return previous;
    }
    const reader = readReader(tx);
    if (reader.revision !== input.revision || reader.policy_revision !== input.policy_revision) throw new MarketStoreError("state_conflict", "Reader or policy changed; read current state first.");
    const now = input.now ?? new Date();
    if (!Number.isFinite(now.getTime())) throw new MarketStoreError("watch_invalid", "Provide a valid clock.");
    let watch: MarketWatch;
    if (input.action === "add") {
      if (!input.kind || !["topic", "work", "platform", "market"].includes(input.kind) || !safe(input.target)) throw new MarketStoreError("watch_invalid", "Provide a supported target kind and safe ref.");
      const target = input.target!;
      const topics = ["revenge", "sweet_romance", "suspense", "fantasy", "urban_power", "family_conflict"];
      if (input.kind === "topic" && (!topics.includes(target) || marketReadPolicy(tx).blocked_topics.includes(target))) throw new MarketStoreError("target_unavailable", "Topic is unknown or blocked.");
      if (input.kind === "platform" && !listSources(tx).some(s => s.platform === target)) throw new MarketStoreError("target_unavailable", "Platform is not registered.");
      if (input.kind === "market" && !OBSERVATION_MARKETS.includes(target)) throw new MarketStoreError("target_unavailable", "Market is not in the observation registry.");
      if (input.kind === "work") {
        // Resolve only existing observed subject refs; never accept a free
        // string as a canonical work identity.
        const match = tx.select().from(marketSignals).all().find(row => row.payload.subject_ref === target);
        if (!match) throw new MarketStoreError("target_unavailable", "Work has not been observed.");
      }
      const ref = "watch-" + marketDigest(["local", input.kind, target]).slice(7, 39);
      const old = tx.select().from(marketWatches).where(eq(marketWatches.ref, ref)).get()?.payload;
      watch = { spec: "radar.market_watch.v1", watch_ref: ref, reader_ref: "local",
        target_kind: input.kind, target_ref: target, state: "active",
        revision: (old?.revision ?? 0) + 1, last_paused_at: old?.last_paused_at ?? null };
    } else {
      if (!safe(input.watch)) throw new MarketStoreError("watch_invalid", "Provide a watch ref.");
      const old = tx.select().from(marketWatches).where(eq(marketWatches.ref, input.watch!)).get()?.payload;
      if (!old) throw new MarketStoreError("watch_not_found", "Watch does not exist.");
      if (old.state === "removed" && input.action !== "remove") throw new MarketStoreError("watch_removed", "Add the target again to restore a removed watch.");
      // Pause/resume/remove keep full history: revisions keep increasing and
      // the pause start survives the resume so its window stays queryable.
      watch = { ...old, revision: old.revision + 1,
        state: input.action === "pause" ? "paused" : input.action === "resume" ? "active" : "removed",
        last_paused_at: input.action === "pause" ? now.toISOString() : old.last_paused_at ?? null };
    }
    assertWatchReadable(tx, watch);
    tx.insert(marketWatches).values({ ref: watch.watch_ref, payload: watch }).onConflictDoUpdate({ target: marketWatches.ref, set: { payload: watch } }).run();
    const revision = reader.revision + 1;
    tx.insert(marketReaders).values({ ref: "local", revision }).onConflictDoUpdate({ target: marketReaders.ref, set: { revision } }).run();
    const receipt: WatchReceipt = { spec: "radar.market_receipt.v1", idempotency_key: input.key,
      payload_digest: digest, action: input.action, reader_revision: revision, outcome: "success", watch };
    tx.insert(marketWatchReceipts).values({ key: input.key, payload: receipt }).run();
    return receipt;
  }, { behavior: "immediate" });
}

export interface WatchChanges {
  spec: "radar.market_watch_changes.v1";
  watch: MarketWatch;
  window: { start: string; end: string };
  signals: ReturnType<typeof pickHeads>;
  coverage: Array<{ source_ref: string; batches_in_window: number; matched_signals: number }>;
  source_gaps: Array<{ source_ref: string; reason: "source_gap" }>;
  limitations: string[];
}

function pickHeads(rows: Array<typeof marketSignals.$inferSelect>) {
  const heads = new Map<string, typeof marketSignals.$inferSelect>();
  for (const row of rows) if (!heads.has(row.ref)) heads.set(row.ref, row);
  return [...heads.values()].map(row => row.payload);
}

// Recorded changes for one watch inside an explicit window. An empty signal
// list with collection gaps is reported as source_gap — absence of data is
// never presented as absence of change.
export function watchChanges(db: RadarDb, input: { watch: string; since?: string; until?: string; now?: Date }) {
  const safe = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(v);
  const now = input.now ?? new Date();
  if (!safe(input.watch) || !Number.isFinite(now.getTime()) ||
    (input.since !== undefined && !isMarketInstant(input.since)) ||
    (input.until !== undefined && !isMarketInstant(input.until))) {
    throw new MarketStoreError("watch_invalid", "Provide a watch ref and UTC window bounds.");
  }
  const row = db.select().from(marketWatches).where(eq(marketWatches.ref, input.watch)).get();
  if (!row) throw new MarketStoreError("watch_not_found", "Watch does not exist.");
  const watch = normalizeWatch(row.payload);
  assertWatchReadable(db, watch);
  // Default window: the last pause period when one exists, else 30 days back.
  const end = input.until ?? now.toISOString();
  const start = input.since ?? watch.last_paused_at ?? new Date(now.getTime() - 30 * 86400000).toISOString();
  if (Date.parse(start) >= Date.parse(end)) throw new MarketStoreError("watch_invalid", "Use an increasing watch window.");
  return db.transaction(tx => {
    const policy = marketReadPolicy(tx);
    const rows = tx.select().from(marketSignals).where(and(
      gte(marketSignals.observedAt, start), lt(marketSignals.observedAt, end),
    )).orderBy(desc(marketSignals.observedAt), desc(marketSignals.revision)).all();
    const platforms = new Map(listSources(tx).map(s => [s.source_ref, s.platform] as const));
    const matches = (signal: ReturnType<typeof pickHeads>[number]) =>
      watch.target_kind === "topic" ? signal.topics.includes(watch.target_ref)
        : watch.target_kind === "work" ? signal.subject_ref === watch.target_ref
          : watch.target_kind === "market" ? signal.market === watch.target_ref
            : platforms.get(signal.source_ref) === watch.target_ref;
    const signals = pickHeads(rows).filter(signal => matches(signal) &&
      (!policy.blocked_topics.length ||
        (signal.topics.length > 0 && !signal.topics.some(t => policy.blocked_topics.includes(t)))));
    // Coverage only names sources that ever delivered a batch; silent sources
    // are gaps, not evidence of no change.
    const everBatched = [...new Set(tx.select({ source: marketBatches.sourceRef }).from(marketBatches).all().map(r => r.source))];
    const coverage = everBatched.sort().map(source => {
      const batches = tx.select({ ref: marketBatches.ref }).from(marketBatches).where(and(
        eq(marketBatches.sourceRef, source), gte(marketBatches.observedAt, start), lt(marketBatches.observedAt, end),
      )).all().length;
      return { source_ref: source, batches_in_window: batches,
        matched_signals: signals.filter(s => s.source_ref === source).length };
    });
    const source_gaps = coverage.filter(c => c.batches_in_window === 0)
      .map(c => ({ source_ref: c.source_ref, reason: "source_gap" as const }));
    const limitations = ["Watch changes cover recorded observations only; they are not a market-wide claim."];
    if (!signals.length && source_gaps.length) {
      limitations.push("No recorded changes in this window, but collection gaps exist; this must not be read as no change.");
    }
    return { spec: "radar.market_watch_changes.v1", watch, window: { start, end },
      signals, coverage, source_gaps, limitations } satisfies WatchChanges;
  });
}
