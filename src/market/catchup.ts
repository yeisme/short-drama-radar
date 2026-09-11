import { and, count, desc, eq, gt, gte, isNull, lt, lte, notExists, or } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { RadarDb } from "../db/client.ts";
import { marketReadMarks, marketSignals } from "../db/schema.ts";
import { isMarketInstant } from "./domain.ts";
import { marketReadPolicy } from "./policy.ts";
import { readReader } from "./reader.ts";
import { MarketStoreError } from "./repository.ts";
import type { MarketSignal } from "./signals.ts";

interface Cursor {
  version: 1; start: string; end: string; reader: number; policy: string;
  generation: number; time: string; ref: string; revision: number; limit: number;
}
function decode(value: string): Cursor {
  try {
    if (value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const c = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (c.version !== 1 || !isMarketInstant(c.start) || !isMarketInstant(c.end) ||
      !isMarketInstant(c.time) || typeof c.ref !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(c.ref) ||
      typeof c.policy !== "string" || c.policy.length > 100 ||
      ![c.reader, c.generation, c.revision, c.limit].every(Number.isSafeInteger) ||
      c.reader < 1 || c.generation < 0 || c.revision < 1 || c.limit < 1 || c.limit > 100 ||
      Date.parse(c.start) >= Date.parse(c.end) || Date.parse(c.end) - Date.parse(c.start) > 30 * 86400000 ||
      Date.parse(c.time) < Date.parse(c.start) || Date.parse(c.time) >= Date.parse(c.end)) throw new Error();
    return c;
  } catch { throw new MarketStoreError("cursor_invalid", "Catch-up cursor is invalid; start a new read."); }
}

export function catchUp(db: RadarDb, options: { cursor?: string; limit?: number; now?: Date } = {}) {
  const cursor = options.cursor ? decode(options.cursor) : null;
  const limit = options.limit ?? cursor?.limit ?? 20;
  const now = options.now ?? new Date();
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isFinite(now.getTime())) {
    throw new MarketStoreError("page_invalid", "Use a valid time and a limit between 1 and 100.");
  }
  if (cursor && Date.parse(cursor.end) > now.getTime()) throw new MarketStoreError("cursor_invalid", "Catch-up cursor cannot end in the future; start a new read.");
  // One SQLite read transaction makes policy, reader revision and signal
  // generation consistent. Additions during pagination invalidate the cursor
  // rather than silently skipping backfilled observations.
  return db.transaction(tx => {
    const reader = readReader(tx), policy = marketReadPolicy(tx);
    const generation = tx.select({ n: count() }).from(marketSignals).get()!.n;
    if (cursor && (cursor.reader !== reader.revision || cursor.policy !== policy.policy_revision ||
      cursor.generation !== generation || cursor.limit !== limit)) {
      throw new MarketStoreError("state_conflict", "Reader, policy or signals changed; restart catch-up.");
    }
    const end = cursor?.end ?? now.toISOString();
    const start = cursor?.start ?? new Date(now.getTime() - 30 * 86400000).toISOString();
    const newer = alias(marketSignals, "newer_signal");
    const boundary = cursor ? or(
      lt(marketSignals.observedAt, cursor.time),
      and(eq(marketSignals.observedAt, cursor.time), gt(marketSignals.ref, cursor.ref)),
      and(eq(marketSignals.observedAt, cursor.time), eq(marketSignals.ref, cursor.ref), lt(marketSignals.revision, cursor.revision)),
    ) : undefined;
    const rows = tx.select({ signal: marketSignals.payload }).from(marketSignals)
      .leftJoin(marketReadMarks, and(
        eq(marketReadMarks.readerRef, "local"), eq(marketReadMarks.signalRef, marketSignals.ref),
        eq(marketReadMarks.signalRevision, marketSignals.revision),
      )).where(and(
        gte(marketSignals.observedAt, start), lt(marketSignals.observedAt, end), boundary,
        isNull(marketReadMarks.signalRef),
        notExists(tx.select({ ref: newer.ref }).from(newer).where(and(eq(newer.ref, marketSignals.ref),
          gt(newer.revision, marketSignals.revision), lt(newer.observedAt, end), gte(newer.observedAt, start)))),
      )).orderBy(desc(marketSignals.observedAt), marketSignals.ref, desc(marketSignals.revision)).limit(501).all();
    const signals: MarketSignal[] = [];
    let scanned = 0, last: MarketSignal | undefined;
    // Bounded scan prevents a heavily filtered policy from materializing an
    // entire history. An empty page can still carry a continuation cursor.
    for (const { signal } of rows.slice(0, 500)) {
      const readable = !policy.blocked_topics.length ||
        (signal.topics.length > 0 && !signal.topics.some(t => policy.blocked_topics.includes(t)));
      if (readable && signals.length === limit) break;
      scanned++;
      last = signal;
      if (readable) signals.push(signal);
    }
    const next = last && scanned < rows.length ? Buffer.from(JSON.stringify({
      version: 1, start, end, reader: reader.revision, policy: policy.policy_revision, generation,
      time: last.observed_at, ref: last.signal_ref, revision: last.revision, limit,
    } satisfies Cursor)).toString("base64url") : null;
    return { spec: "radar.market_catchup.v1", reader_revision: reader.revision,
      policy_revision: policy.policy_revision, window: { start, end }, signals,
      next_cursor: next, history_limited: true,
      limitations: ["Catch-up covers the last 30 days. Older signal revisions remain available by ref."] };
  });
}
