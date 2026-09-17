import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { openDb } from "../../src/db/client.ts";
import { marketObservations, marketObservationQuality, marketEvidence } from "../../src/db/schema.ts";
import { initializeMarket, registerSourceCandidate } from "../../src/market/sources.ts";
import { observeCatalog } from "../../src/market/observe.ts";
import { parseCatalog } from "../../src/market/catalog.ts";
import { sourceByRef } from "../../src/market/repository.ts";

for (const [language, market] of [["ja", "JP"], ["ko", "KR"]]) {
  const source = `reelshort-${language}`;
  const html = readFileSync(`test/fixtures/market/${source}-fields.html`, "utf8");
  test(`${source} preserves localized identity and rejects foreign language routes`, async () => {
    const parsed = await parseCatalog(source, html, "html");
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.every(i => i.category === null && i.episode_count === null)).toBe(true);
    expect(parsed.items.every(i => !i.title.includes("全シリーズ") && !i.url.includes("tracking"))).toBe(true);
    expect(parsed.skipped.foreign_or_unsafe_link).toBe(1);
    expect(parsed.skipped.no_work_identity).toBe(2);
  });
  test(`${source} fixture and injected fetch keep readiness, unknown geography and origin honest`, async () => {
    const db = openDb(":memory:");
    try {
      initializeMarket(db);
      registerSourceCandidate(db, { source_ref: source, publisher_group: "reelshort", locale: language, markets: [market!] });
      const input = { source, mode: "verify-sample" as const, observedAt: "2026-09-17T02:00:00Z" };
      await expect(observeCatalog(db, input)).rejects.toThrow("--confirm-live");
      await expect(observeCatalog(db, { ...input, mode: "production", confirmLive: true })).rejects.toThrow("requires sample_verified");
      const fixture = await observeCatalog(db, { ...input, fixture: true, fixtureDir: "test/fixtures" });
      expect(fixture.origin).toBe("fixture");
      let request = "";
      // Mock provider payload exercises the live ingress; this is not a real source receipt.
      const fetchImpl = async (_: string | URL | Request, init?: RequestInit) => {
        request = String(init?.body); return Response.json({ data: { rawHtml: html } });
      };
      const result = await observeCatalog(db, { ...input, confirmLive: true, fetchImpl });
      expect(result.items).toBe(2);
      expect(result.limitations.some(line => line.includes("outside this localized work URL contract"))).toBe(true);
      expect(result.origin).toBe("live");
      expect(JSON.parse(request).url).toBe(`https://www.reelshort.com/${language}`);
      expect((await observeCatalog(db, { ...input, confirmLive: true, fetchImpl })).reused).toBe(true);
      expect(sourceByRef(db, source)!.readiness).toBe("planned");
      const rows = db.select().from(marketObservations).all();
      expect(rows).toHaveLength(4);
      for (const { payload: o } of rows) {
        expect(o.locale).toBe(language); expect(o.market).toBe("unknown");
        expect(o.format).toBe("unknown"); expect(o.facts).toEqual([]);
      }
      expect(db.select().from(marketObservationQuality).all().every(r => r.payload.parser_version === "reelshort-localized-links.v1")).toBe(true);
      expect(JSON.stringify(db.select().from(marketEvidence).all())).not.toContain("<html");
    } finally { db.$client.close(); }
  });
}

test("localized catalog refuses a mismatched descriptor and redacts provider exceptions", async () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    registerSourceCandidate(db, { source_ref: "reelshort-ja", publisher_group: "other", locale: "en", markets: ["JP"] });
    await expect(observeCatalog(db, { source: "reelshort-ja", mode: "verify-sample", fixture: true, fixtureDir: "test/fixtures" })).rejects.toThrow("matching language");
    await expect(observeCatalog(db, { source: "reelshort-ja", mode: "verify-sample", confirmLive: true,
      fetchImpl: async () => { throw new Error("synthetic-private-provider-context"); } })).rejects.toThrow("check provider availability");
    expect(db.select().from(marketObservations).all()).toHaveLength(0);
  } finally { db.$client.close(); }
});
