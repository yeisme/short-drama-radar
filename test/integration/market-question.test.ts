import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { openDb } from "../../src/db/client.ts";
import { initializeMarket, updateSettings } from "../../src/market/sources.ts";
import { importCatalog } from "../../src/market/catalog.ts";
import { analyzeMarket, signalByRef } from "../../src/market/signals.ts";
import { evidenceForSignal, questionContext } from "../../src/market/question.ts";
import { readReader } from "../../src/market/reader.ts";

test("question context binds evidence to exact revision and applies current policy without read side effects", async () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    await importCatalog(db, { source: "dramabox", content: readFileSync("test/fixtures/market/dramabox.md", "utf8"),
      format: "markdown", observedAt: "2026-09-10T08:00:00Z", origin: "fixture" });
    const result = analyzeMarket(db, "2026-09-10T00:00:00Z", "2026-09-11T00:00:00Z");
    const signal = signalByRef(db, result.signals[0].ref)!;
    const reader = readReader(db);
    const context = questionContext(db, { signal_ref: signal.signal_ref, revision: 1, question: "How much revenue did this generate?" });
    expect(context.signal_revision).toBe(1);
    expect(context.evidence).toHaveLength(1);
    expect(context.answer_contract.unknown).toContain("do not infer revenue");
    expect(context.evidence.every(e => e.summary.length <= 500)).toBe(true);
    expect(JSON.stringify(context)).not.toContain("public_url");
    expect(readReader(db)).toEqual(reader);
    expect(() => evidenceForSignal(db, signal.signal_ref, 1, "unrelated")).toThrow("not attached");
    expect(() => questionContext(db, { signal_ref: signal.signal_ref, revision: 99, question: "Why?" })).toThrow("does not exist");
    updateSettings(db, 1, { blocked_topics: ["taboo"] });
    expect(() => questionContext(db, { signal_ref: signal.signal_ref, revision: 1, question: "Why?" })).toThrow("not been classified");
    expect(() => evidenceForSignal(db, signal.signal_ref, 1, signal.evidence_refs[0])).toThrow("not been classified");
  } finally { db.$client.close(); }
});
