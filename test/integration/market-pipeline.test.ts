import { expect, test } from "bun:test";
import { openDb } from "../../src/db/client.ts";
import { initializeMarket } from "../../src/market/sources.ts";
import { saveObservationBatch } from "../../src/market/repository.ts";
import { analyzeMarket, correctSignal, signalByRef } from "../../src/market/signals.ts";
import { buildMarketBrief, readMarketBrief } from "../../src/market/brief.ts";
import { catchUp } from "../../src/market/catchup.ts";
import { changeReadState, isRead, readReader, readerReceipt } from "../../src/market/reader.ts";
import { marketReadPolicy } from "../../src/market/policy.ts";
import { marketEvidence, marketSignals } from "../../src/db/schema.ts";
import type { MarketObservation } from "../../src/market/domain.ts";

// Task 5.1 (pipeline side, S11/S13): corrections, a client disconnect, and a
// reconnect replay in one chain — no fake rises, no duplicate actions, and
// no lost unread state anywhere in between.

function observation(ref: string, item: string, day: string, value: number): MarketObservation {
  const prev = new Date(Date.parse(day + "T00:00:00Z") - 86400000).toISOString().slice(0, 10);
  return {
    spec: "radar.market_observation.v1", observation_ref: ref,
    source_ref: "hongguo", source_revision: 1, source_item_id: item,
    source_snapshot_ref: "snapshot-" + ref, observed_at: day + "T08:00:00Z", source_published_at: null,
    market: "unknown", market_evidence_refs: [], locale: "zh", format: "unknown",
    production_method: "unknown", production_evidence_refs: [], title: "Pipeline fixture " + item,
    topics: ["suspense"], facts: [{ name: "engagement", value, unit: "count", basis: "interval",
      window: { start: prev + "T00:00:00Z", end: day + "T00:00:00Z" }, definition_version: "v1", sample_denominator: null }],
    evidence_refs: ["evidence-" + ref], collection_run_ref: "run-pipeline", origin: "fixture",
  };
}

function day(db: ReturnType<typeof openDb>, dayIso: string, value: number) {
  saveObservationBatch(db, { ref: "pipe-" + dayIso, source_ref: "hongguo", source_revision: 1,
    observed_at: dayIso + "T08:00:00Z", origin: "fixture",
    observations: [observation("p-" + dayIso, "w1", dayIso, value)] });
  const next = new Date(Date.parse(dayIso + "T00:00:00Z") + 86400000).toISOString().slice(0, 10);
  analyzeMarket(db, dayIso + "T00:00:00Z", next + "T00:00:00Z");
}

test("correction plus disconnect and reconnect keeps reads exact", () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    day(db, "2026-09-10", 100);
    day(db, "2026-09-11", 130);
    buildMarketBrief(db, "2026-09-10T00:00:00Z", "2026-09-12T00:00:00Z", new Date("2026-09-12T09:00:00Z"));
    const metric = db.select().from(marketSignals).all().map(r => r.payload)
      .find(s => s.claim_kind === "metric_changed")!;
    const brief = readMarketBrief(db);

    // The reader marks exactly the visible revisions read, with a receipt.
    const reader = readReader(db), policy = marketReadPolicy(db);
    const markInput = { action: "mark" as const, idempotency_key: "pipeline-read-1",
      expected_revision: reader.revision, policy_revision: policy.policy_revision,
      signals: brief.visible_signal_refs.map(r => ({ ref: r.ref, revision: r.revision })) };
    const originalRevision = JSON.stringify(signalByRef(db, metric.signal_ref, metric.revision));
    const mark = changeReadState(db, markInput);
    expect(mark.signals.every(s => isRead(db, s))).toBe(true);
    expect(catchUp(db, { now: new Date("2026-09-12T10:00:00Z") }).signals).toEqual([]);

    // A correction lands the next day: only the new revision is unread.
    db.insert(marketEvidence).values({ ref: "evidence-pipeline-correction", sourceRef: "hongguo",
      observedAt: "2026-09-11T08:00:00Z",
      payload: { title: "Correction evidence", public_url: "", source_item_id: "w1", origin: "fixture" } }).run();
    const corrected = correctSignal(db, { ref: metric.signal_ref, expected_revision: metric.revision,
      reason: "upstream corrected the metric", evidence_refs: ["evidence-pipeline-correction"],
      outcome: "retracted", corrected_at: "2026-09-12T10:30:00Z" });
    const afterCorrection = catchUp(db, { now: new Date("2026-09-12T11:00:00Z") });
    expect(afterCorrection.signals.map(s => s.revision)).toEqual([corrected.signal.revision]);
    expect(isRead(db, { ref: metric.signal_ref, revision: metric.revision })).toBe(true);
    // The corrected-away revision stays byte-identical (immutable history).
    expect(JSON.stringify(signalByRef(db, metric.signal_ref, metric.revision))).toBe(originalRevision);

    // Disconnect: the client loses the mark response and replays the SAME
    // key+payload after reconnecting. The receipt replays without a second
    // action and without advancing the reader revision twice.
    const revisionAfterCorrection = readReader(db).revision;
    const replay = changeReadState(db, markInput);
    expect(replay.payload_digest).toBe(mark.payload_digest);
    expect(readReader(db).revision).toBe(revisionAfterCorrection);
    expect(readerReceipt(db, "pipeline-read-1")!.payload_digest).toBe(mark.payload_digest);
    // Same key, different payload: refused, original receipt untouched.
    expect(() => changeReadState(db, { ...markInput,
      signals: [{ ref: metric.signal_ref, revision: corrected.signal.revision }] })).toThrow("different parameters");
    expect(readerReceipt(db, "pipeline-read-1")!.reader_revision).toBe(mark.reader_revision);

    // Reconnected catch-up still shows exactly the unread correction.
    const reconnected = catchUp(db, { now: new Date("2026-09-12T12:00:00Z") });
    expect(reconnected.signals.map(s => s.signal_ref)).toEqual([metric.signal_ref]);
    expect(reconnected.signals[0]!.revision).toBe(corrected.signal.revision);
    // No fake rise anywhere: the correction is a retraction, not a movement.
    expect(reconnected.signals[0]!.claim_kind).toBe("correction");
    expect(reconnected.signals[0]!.comparison).toBeNull();
  } finally { db.$client.close(); }
});
