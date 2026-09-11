import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { openDb } from "../../src/db/client.ts";
import { initializeMarket, updateSettings } from "../../src/market/sources.ts";
import { importCatalog } from "../../src/market/catalog.ts";
import { analyzeMarket, signalByRef } from "../../src/market/signals.ts";
import { saveWorkCandidate, workMapping } from "../../src/market/identity.ts";
import { crossMarketView } from "../../src/market/cross-market.ts";
import { marketCommand } from "../../src/market/cli.ts";
import { readReader } from "../../src/market/reader.ts";
import { saveObservationBatch } from "../../src/market/repository.ts";

test("comparison preserves unknown geography and candidate identity without reading or merging works", async () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    for (const source of ["hongguo", "reelshort"]) {
      await importCatalog(db, { source, content: readFileSync(`test/fixtures/market/${source}.html`, "utf8"),
        format: "html", observedAt: "2026-09-10T08:00:00Z", origin: "fixture" });
    }
    const analysis = analyzeMarket(db, "2026-09-10T00:00:00Z", "2026-09-11T00:00:00Z");
    const signals = analysis.signals.map(s => signalByRef(db, s.ref)!);
    const a = signals.find(s => s.source_ref === "hongguo")!;
    const b = signals.find(s => s.source_ref === "reelshort")!;
    // Catalog imports already created per-source candidates; guess a shared
    // canonical ref on both sides to prove a candidate guess alone never
    // establishes identity.
    for (const signal of [a, b]) {
      const prior = workMapping(db, signal.subject_ref)!;
      expect(prior.mapping_status).toBe("candidate");
      saveWorkCandidate(db, {
        platform_work_ref: signal.subject_ref, canonical_work_ref: "possible-same-work",
        original_title: signal.title, aliases: [], mapping_revision: prior.mapping_revision + 1,
        mapping_status: "candidate", supporting_evidence_refs: prior.supporting_evidence_refs,
      }, prior.mapping_revision);
    }
    const left = { signal_ref: a.signal_ref, revision: a.revision };
    const right = { signal_ref: b.signal_ref, revision: b.revision };
    const reader = readReader(db);
    const view = crossMarketView(db, left, right);
    expect(view.identity_relation).toBe("not_established");
    expect(view.sides.map(s => s.market)).toEqual(["unknown", "unknown"]);
    expect(view.sides.map(s => s.identity.mapping_status)).toEqual(["candidate", "candidate"]);
    expect(view.sides[0].observations[0].original_title).toBe(a.title);
    expect(view.sides[1].observations[0].source_ref).toBe("reelshort");
    expect(view.sides.every(s => s.observations[0].facts.length === 0)).toBe(true);
    expect(view.shared_numeric_axis).toBe(false);
    expect(view.causal_inference).toBe(false);
    expect(readReader(db)).toEqual(reader);
    const flags = new Map(Object.entries({ left: [left.signal_ref], "left-revision": ["1"],
      right: [right.signal_ref], "right-revision": ["1"] }));
    expect((await marketCommand(["market", "compare"], flags, db)).data).toEqual(view);
    expect(() => crossMarketView(db, left, { ...right, revision: 999 })).toThrow("does not exist");
    expect(() => crossMarketView(db, left, { ...right, revision: NaN })).toThrow("positive revisions");
    updateSettings(db, 1, { blocked_topics: ["taboo"] });
    expect(() => crossMarketView(db, left, right)).toThrow();
  } finally { db.$client.close(); }
});

test("one blocked side rejects the whole comparison with a safe error in either order", () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    const at = "2026-09-10T08:00:00Z";
    for (const [source, topic] of [["hongguo", "romance"], ["reelshort", "taboo"]]) {
      saveObservationBatch(db, { ref: "batch-" + source, source_ref: source, source_revision: 1,
        observed_at: at, origin: "fixture", observations: [{
          spec: "radar.market_observation.v1", observation_ref: "obs-" + source,
          source_ref: source, source_revision: 1, source_item_id: "sample",
          source_snapshot_ref: "snapshot-" + source, observed_at: at, source_published_at: null,
          market: "unknown", market_evidence_refs: [], locale: "en", format: "unknown",
          production_method: "unknown", production_evidence_refs: [], title: "Private fixture title " + topic,
          topics: [topic], facts: [], evidence_refs: ["snapshot-" + source],
          collection_run_ref: "run-" + source, origin: "fixture",
        }] });
    }
    const signals = analyzeMarket(db, "2026-09-10T00:00:00Z", "2026-09-11T00:00:00Z").signals;
    const selections = signals.map(s => ({ signal_ref: s.ref, revision: s.revision }));
    updateSettings(db, 1, { blocked_topics: ["taboo"] });
    for (const [left, right] of [[selections[0], selections[1]], [selections[1], selections[0]]]) {
      try {
        crossMarketView(db, left, right);
        throw new Error("Expected content rejection");
      } catch (error) {
        expect(error).toMatchObject({ code: "content_blocked" });
        expect((error as Error).message).not.toContain("Private fixture title");
      }
    }
  } finally { db.$client.close(); }
});
