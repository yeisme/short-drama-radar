import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { openDb } from "../../src/db/client.ts";
import { marketObservations } from "../../src/db/schema.ts";
import { initializeMarket } from "../../src/market/sources.ts";
import { importCatalog, parseCatalog } from "../../src/market/catalog.ts";

// Task 1.7: ReelShort/DramaBox shared catalog parsing. Works keep stable
// refs; the global platform and any country evidence stay separate, so an
// English page never becomes a US audience claim.

test("reelshort parsing keeps stable work refs and separates global scope from country evidence", async () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    const receipt = await importCatalog(db, { source: "reelshort",
      content: readFileSync("test/fixtures/market/reelshort-fields.html", "utf8"),
      format: "html", observedAt: "2026-09-10T08:00:00Z", origin: "fixture" });
    expect(receipt.items).toBe(3);
    expect(receipt.field_coverage).toEqual({ category: 3, episode_count: 2 });
    const rows = db.select().from(marketObservations).all().map(row => row.payload);
    const byId = Object.fromEntries(rows.map(row => [row.source_item_id, row]));
    expect(byId["6a5191d8fa9f9f7a09081789"].title).toBe("Sample City Love");
    expect(byId["6a72f122a2ed0db5070b250d"].title).toBe("Sample Family Ties");
    // The episode player link is not a work identity.
    expect(byId["6b81c233b3fe1ec6071c361e"].facts).toHaveLength(0);
    expect(byId["6a5191d8fa9f9f7a09081789"].topics).toEqual(["sweet_romance"]);
    expect(byId["6a72f122a2ed0db5070b250d"].topics).toEqual(["family_conflict"]);
    expect(byId["6b81c233b3fe1ec6071c361e"].topics).toEqual([]);
    // English locale is preserved while the market stays unknown: language
    // never implies geography and no country evidence is fabricated.
    for (const row of rows) {
      expect(row.locale).toBe("en");
      expect(row.market).toBe("unknown");
      expect(row.market_evidence_refs).toEqual([]);
    }
    expect(JSON.stringify(rows)).not.toContain("US");
  } finally { db.$client.close(); }
});

test("dramabox markdown parsing extracts fields and skips non-work entries", async () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    const receipt = await importCatalog(db, { source: "dramabox",
      content: readFileSync("test/fixtures/market/dramabox-fields.md", "utf8"),
      format: "markdown", observedAt: "2026-09-10T08:00:00Z", origin: "fixture" });
    expect(receipt.items).toBe(2);
    expect(receipt.field_coverage).toEqual({ category: 2, episode_count: 2 });
    expect(receipt.skipped_links).toEqual({ foreign_or_unsafe_link: 1, no_work_identity: 1, title_invalid: 0 });
    const byId = Object.fromEntries(db.select().from(marketObservations).all().map(row => [row.payload.source_item_id, row.payload]));
    // Stable ids; both zh and en episode notations parse; titles are clean.
    expect(byId["42000021383"].title).toBe("Sample Drama");
    expect(byId["42000021383"].topics).toEqual(["sweet_romance"]);
    expect(byId["42000018431"].title).toBe("Quiet Witness");
    expect(byId["42000018431"].topics).toEqual(["suspense"]);
    expect(byId["42000021383"].facts[0].value).toBe(60);
    expect(byId["42000018431"].facts[0].value).toBe(24);
    expect(Object.values(byId).every(row => row.market === "unknown")).toBe(true);
  } finally { db.$client.close(); }
});

test("works without any field text stay importable with explicit zero coverage", async () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    const receipt = await importCatalog(db, { source: "reelshort",
      content: "[Plain Work](https://www.reelshort.com/movie/plain-work-6c90d344c40f2fd7182d473f)",
      format: "markdown", observedAt: "2026-09-10T08:00:00Z", origin: "fixture" });
    expect(receipt.items).toBe(1);
    expect(receipt.field_coverage).toEqual({ category: 0, episode_count: 0 });
    const row = db.select().from(marketObservations).all()[0].payload;
    expect(row.title).toBe("Plain Work");
    expect(row.topics).toEqual([]);
    expect(row.facts).toEqual([]);
  } finally { db.$client.close(); }
});
