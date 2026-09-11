import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { openDb } from "../../src/db/client.ts";
import { initializeMarket, updateSettings } from "../../src/market/sources.ts";
import { importCatalog } from "../../src/market/catalog.ts";
import { analyzeMarket, correctSignal, signalByRef } from "../../src/market/signals.ts";
import { buildMarketReview, readMarketReview } from "../../src/market/review.ts";
import { marketCommand } from "../../src/market/cli.ts";
import { previousMarketWindow } from "../../src/market/calendar.ts";

test("review freezes cutoff evidence and distinguishes missing followup from retraction", async () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    await importCatalog(db, { source: "dramabox", content: readFileSync("test/fixtures/market/dramabox.md", "utf8"),
      format: "markdown", observedAt: "2026-09-10T08:00:00Z", origin: "fixture" });
    const analysis = analyzeMarket(db, "2026-09-10T00:00:00Z", "2026-09-11T00:00:00Z");
    const signal = signalByRef(db, analysis.signals[0].ref)!;
    const start = "2026-09-10T00:00:00Z", end = "2026-09-11T00:00:00Z";
    const old = buildMarketReview(db, start, end, "2026-09-11T08:00:00Z");
    expect(old.review.entries.every(e => e.outcome === "inconclusive")).toBe(true);
    correctSignal(db, { ref: signal.signal_ref, expected_revision: 1, reason: "Withdraw this observation claim.",
      evidence_refs: signal.evidence_refs, corrected_at: "2026-09-11T09:00:00Z", outcome: "retracted" });
    const now = new Date("2026-09-12T08:00:00Z");
    const next = buildMarketReview(db, start, end, "2026-09-12T08:00:00Z", now);
    expect(next.review.entries.map(e => e.outcome).sort()).toEqual(["inconclusive", "retracted"]);
    expect(readMarketReview(db, old.review.review_ref).entries.every(e => e.followup === null)).toBe(true);
    expect(buildMarketReview(db, start, end, "2026-09-12T08:00:00Z", now).reused).toBe(true);
    expect(() => buildMarketReview(db, start, end, "2026-09-12T08:00:01Z", now)).toThrow("no future cutoff");
    expect(next.review.entries.find(e => e.outcome === "retracted")?.original.revision).toBe(1);
    expect(next.review.entries.find(e => e.outcome === "retracted")?.followup?.revision).toBe(2);
    updateSettings(db, 1, { blocked_topics: ["taboo"] });
    expect(readMarketReview(db, next.review.review_ref).entries).toEqual([]);
    expect(readMarketReview(db, next.review.review_ref).digest).toBe(next.review.digest);
  } finally { db.$client.close(); }
});

test("CLI builds complete local periods by default and rejects half-specified windows", async () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    updateSettings(db, 1, { timezone: "Asia/Shanghai" });
    const brief = await marketCommand(["market", "brief", "build"], new Map(), db);
    expect(brief.data).toMatchObject({ window: previousMarketWindow("Asia/Shanghai", "day"), status: "empty" });
    const review = await marketCommand(["market", "review", "build"], new Map(), db);
    expect(review.data).toMatchObject({ window: previousMarketWindow("Asia/Shanghai", "week"), entries: [] });
    await expect(marketCommand(["market", "review", "build"], new Map([["start", ["2026-09-01T00:00:00Z"]]]), db)).rejects.toThrow("--end");
  } finally { db.$client.close(); }
});
