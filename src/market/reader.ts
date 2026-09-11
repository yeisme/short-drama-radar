import { and, eq } from "drizzle-orm";
import type { RadarDb } from "../db/client.ts";
import { marketReaders, marketReadMarks, marketReaderReceipts } from "../db/schema.ts";
import { marketDigest, MarketStoreError } from "./repository.ts";
import { signalByRef } from "./signals.ts";
import { assertMarketContentReadable, marketReadPolicy } from "./policy.ts";

export interface SignalVersion { ref: string; revision: number }
export interface ReaderReceipt {
  spec: "radar.market_receipt.v1";
  idempotency_key: string;
  payload_digest: string;
  action: "mark" | "unread";
  outcome: "success";
  reader_ref: "local";
  reader_revision: number;
  signals: SignalVersion[];
}

export function readReader(db: RadarDb) {
  const reader = db.select().from(marketReaders).where(eq(marketReaders.ref, "local")).get();
  return {
    spec: "radar.market_reader.v1", reader_ref: "local",
    revision: reader?.revision ?? 1, policy_revision: marketReadPolicy(db).policy_revision,
  };
}

export function readerReceipt(db: RadarDb, key: string): ReaderReceipt | null {
  return db.select().from(marketReaderReceipts).where(eq(marketReaderReceipts.key, key)).get()?.payload ?? null;
}

export function isRead(db: RadarDb, signal: SignalVersion): boolean {
  return Boolean(db.select().from(marketReadMarks).where(and(
    eq(marketReadMarks.readerRef, "local"), eq(marketReadMarks.signalRef, signal.ref),
    eq(marketReadMarks.signalRevision, signal.revision),
  )).get());
}

export function changeReadState(db: RadarDb, input: {
  action: "mark" | "unread"; idempotency_key: string; expected_revision: number;
  policy_revision: string; signals: SignalVersion[];
}): ReaderReceipt {
  const refValid = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(v);
  if (!input || !["mark", "unread"].includes(input.action) || !refValid(input.idempotency_key) ||
    !Number.isSafeInteger(input.expected_revision) || input.expected_revision < 1 ||
    !Array.isArray(input.signals) || input.signals.length < 1 || input.signals.length > 100 ||
    input.signals.some(s => !s || !refValid(s.ref) || !Number.isSafeInteger(s.revision) || s.revision < 1)) {
    throw new MarketStoreError("reader_input_invalid", "Provide an action, key, reader revision and 1–100 explicit signal revisions.");
  }
  const signals = [...new Map(input.signals.map(s => [s.ref + ":" + s.revision, { ref: s.ref, revision: s.revision }])).values()]
    .sort((a, b) => a.ref.localeCompare(b.ref) || a.revision - b.revision);
  const digest = marketDigest({ action: input.action, reader: "local", expected_revision: input.expected_revision,
    policy_revision: input.policy_revision, signals });
  return db.transaction(tx => {
    const prior = readerReceipt(tx, input.idempotency_key);
    if (prior) {
      if (prior.payload_digest !== digest) throw new MarketStoreError("idempotency_conflict", "Reader key was already used with different parameters.");
      return prior;
    }
    const reader = readReader(tx);
    if (reader.revision !== input.expected_revision || reader.policy_revision !== input.policy_revision) {
      throw new MarketStoreError("state_conflict", "Reader or content policy changed; read the current state before retrying.");
    }
    for (const signal of signals) {
      const record = signalByRef(tx, signal.ref, signal.revision);
      if (!record) throw new MarketStoreError("signal_not_found", "Requested signal revision does not exist.");
      assertMarketContentReadable(tx, record.topics);
    }
    for (const signal of signals) {
      if (input.action === "mark") tx.insert(marketReadMarks).values({
        readerRef: "local", signalRef: signal.ref, signalRevision: signal.revision,
      }).onConflictDoNothing().run();
      else tx.delete(marketReadMarks).where(and(eq(marketReadMarks.readerRef, "local"),
        eq(marketReadMarks.signalRef, signal.ref), eq(marketReadMarks.signalRevision, signal.revision))).run();
    }
    const revision = reader.revision + 1;
    tx.insert(marketReaders).values({ ref: "local", revision }).onConflictDoUpdate({
      target: marketReaders.ref, set: { revision },
    }).run();
    const receipt: ReaderReceipt = { spec: "radar.market_receipt.v1", action: input.action,
      idempotency_key: input.idempotency_key, payload_digest: digest, outcome: "success",
      reader_ref: "local", reader_revision: revision, signals };
    tx.insert(marketReaderReceipts).values({ key: input.idempotency_key, payload: receipt }).run();
    return receipt;
  }, { behavior: "immediate" });
}
