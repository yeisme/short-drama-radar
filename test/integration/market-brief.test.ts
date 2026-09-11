import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { openDb } from "../../src/db/client.ts";
import { initializeMarket, updateSettings } from "../../src/market/sources.ts";
import { importCatalog } from "../../src/market/catalog.ts";
import { analyzeMarket } from "../../src/market/signals.ts";
import { buildMarketBrief, marketBriefByRef, readMarketBrief } from "../../src/market/brief.ts";

test("catalog to brief freezes history, reuses replay and applies current read policy without mutating the edition", async () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    expect(() => readMarketBrief(db)).toThrow("No completed");
    await importCatalog(db, { source: "dramabox", content: readFileSync("test/fixtures/market/dramabox.md", "utf8"),
      format: "markdown", observedAt: "2026-09-10T08:00:00Z", origin: "fixture" });
    analyzeMarket(db, "2026-09-10T00:00:00Z", "2026-09-11T00:00:00Z");
    const first = buildMarketBrief(db, "2026-09-10T00:00:00Z", "2026-09-11T00:00:00Z", new Date("2026-09-11T08:00:00Z"));
    expect(first.brief.signals).toHaveLength(2);
    expect(first.brief.status).toBe("degraded");
    const before = readMarketBrief(db);
    expect(before.main).toEqual([]);
    expect(before.watching).toHaveLength(2);
    expect(before.window.end).toBe("2026-09-11T00:00:00.000Z");
    expect(buildMarketBrief(db, "2026-09-10T00:00:00Z", "2026-09-11T00:00:00Z", new Date("2026-09-11T09:00:00Z")).reused).toBe(true);
    updateSettings(db, 1, { blocked_topics: ["taboo"] });
    const after = readMarketBrief(db);
    expect(after.filtered).toBe(true);
    expect(after.watching).toEqual([]);
    expect(after.digest).toBe(before.digest);
    expect(after.policy_revision).not.toBe(before.policy_revision);
    expect(marketBriefByRef(db, first.brief.brief_ref)?.signals).toHaveLength(2);
    expect(() => buildMarketBrief(db, "2026-09-12T00:00:00Z", "2026-09-13T00:00:00Z", new Date("2026-09-11T08:00:00Z"))).toThrow("completed");
  } finally { db.$client.close(); }
});

test("empty completed window is distinct from missing brief and keeps coverage limitations", () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    const result = buildMarketBrief(db, "2026-09-10T00:00:00Z", "2026-09-11T00:00:00Z", new Date("2026-09-11T08:00:00Z"));
    expect(result.brief.status).toBe("empty");
    expect(readMarketBrief(db).coverage.sources).toHaveLength(18);
    expect(readMarketBrief(db).limitations.length).toBeGreaterThan(0);
  } finally { db.$client.close(); }
});
