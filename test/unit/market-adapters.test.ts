import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { openDb } from "../../src/db/client.ts";
import { marketBatches, marketEvidence, marketObservations } from "../../src/db/schema.ts";
import { initializeMarket } from "../../src/market/sources.ts";
import { importCatalog, parseCatalog } from "../../src/market/catalog.ts";
import { marketCommand } from "../../src/market/cli.ts";

// Task 1.5: the catalog/manual import adapter boundary. S03 keeps an
// unparseable page distinguishable from an invalid batch; S04 keeps empty,
// malformed and partial failures identifiable without partial commits.

const fields = () => readFileSync("test/fixtures/market/hongguo-fields.html", "utf8");

test("empty and malformed inputs stay distinguishable and never partially commit (S03/S04)", async () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    // Malformed: no parser is registered for an arbitrary target.
    await expect(parseCatalog("not-a-source", "<a href='/'>x</a>", "html")).rejects.toThrow("No catalog parser");
    // Malformed: bounded input size is enforced before parsing.
    await expect(parseCatalog("hongguo", "x".repeat(2_000_001), "html")).rejects.toThrow("2 MB");
    // S03: a legitimate page with no parseable catalog is an honest
    // source_unavailable, not an invalid input.
    const empty = await parseCatalog("hongguo", "<html><body>Login required</body></html>", "html");
    expect(empty.status).toBe("unavailable");
    expect(empty.reason).toBe("no_parseable_catalog_items");
    // S04: invalid observation time and unknown sources reject the whole
    // batch; nothing is written.
    await expect(importCatalog(db, { source: "hongguo", content: fields(), format: "html", observedAt: "2026-09-10 08:00:00", origin: "fixture" })).rejects.toThrow("UTC instant");
    await expect(importCatalog(db, { source: "reelshort", content: fields(), format: "html", observedAt: "2026-09-10T08:00:00Z", origin: "fixture" })).rejects.toThrow("No parseable");
    expect(db.select().from(marketBatches).all()).toHaveLength(0);
    expect(db.select().from(marketObservations).all()).toHaveLength(0);
    expect(db.select().from(marketEvidence).all()).toHaveLength(0);
  } finally { db.$client.close(); }
});

test("partial failures and missing per-source fields are counted, not hidden", async () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    const receipt = await importCatalog(db, { source: "hongguo", content: fields(), format: "html", observedAt: "2026-09-10T08:00:00Z", origin: "fixture" });
    expect(receipt.items).toBe(4);
    // Two works carry an episode count, all four carry a category label:
    // partial field availability is explicit coverage, never implied.
    expect(receipt.field_coverage).toEqual({ category: 4, episode_count: 2 });
    expect(receipt.skipped_links).toEqual({ foreign_or_unsafe_link: 1, no_work_identity: 1, title_invalid: 0 });
    // Script bodies never become items even when they contain anchor markup.
    const scripted = await parseCatalog("hongguo",
      "<html><body><script>document.write('<a href=\"/detail?series_id=12345678901234567\">Fake</a>')</script></body></html>", "html");
    expect(scripted.status).toBe("unavailable");
    // Evidence keeps normalized fields only; raw markup never lands.
    const blob = JSON.stringify(db.select().from(marketEvidence).all());
    expect(blob).not.toContain("<");
    expect(blob).not.toContain("script");
  } finally { db.$client.close(); }
});

test("fixture, manual and live origins stay separated at the import boundary", async () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    const asFixture = await importCatalog(db, { source: "hongguo", content: fields(), format: "html", observedAt: "2026-09-10T08:00:00Z", origin: "fixture" });
    expect((await importCatalog(db, { source: "hongguo", content: fields(), format: "html", observedAt: "2026-09-10T08:00:00Z", origin: "fixture" })).reused).toBe(true);
    const asManual = await importCatalog(db, { source: "hongguo", content: fields(), format: "html", observedAt: "2026-09-10T20:00:00Z", origin: "manual" });
    expect(asFixture.batch_ref).not.toBe(asManual.batch_ref);
    const rows = db.select().from(marketObservations).all();
    expect(rows).toHaveLength(8);
    expect(rows.filter(row => row.payload.origin === "fixture")).toHaveLength(4);
    expect(rows.filter(row => row.payload.origin === "manual")).toHaveLength(4);
    // Live collection is only reachable through the deliberately gated
    // observe command; imports can never mint live observations.
    expect(db.select().from(marketBatches).all().every(row => row.origin !== "live")).toBe(true);
    await expect(marketCommand(["market", "observe"], new Map([["source", ["hongguo"]]]), db))
      .rejects.toThrow("--mode");
  } finally { db.$client.close(); }
});

test("fixed targets never accept arbitrary execution parameters or foreign hosts", async () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    const hostile = [
      "[Fake](javascript:alert(1))",
      "[Fake](data:text/html,<a href='x'>x</a>)",
      "[Fake](https://user:pass@novelquickapp.com/detail?series_id=7574794690361297960)",
      "[Fake](http://novelquickapp.com/detail?series_id=7574794690361297960)",
      "[Fake](https://evil.example/detail?series_id=7574794690361297960)",
    ].join("\n");
    const result = await parseCatalog("hongguo", hostile, "markdown");
    expect(result.status).toBe("unavailable");
    // The markdown extractor only considers http(s) targets, so javascript:
    // and data: links are not even eligible; the credentials, plain-http and
    // foreign-host links are counted as unsafe skips.
    expect(result.skipped.foreign_or_unsafe_link).toBe(3);
    // A same-host non-work page is a distinct, named skip category.
    const mixed = await parseCatalog("hongguo", "[隐私政策](https://novelquickapp.com/privacy)", "markdown");
    expect(mixed.status).toBe("unavailable");
    expect(mixed.skipped).toEqual({ foreign_or_unsafe_link: 0, no_work_identity: 1, title_invalid: 0 });
  } finally { db.$client.close(); }
});
