import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { openDb } from "../../src/db/client.ts";
import { marketEvidence, marketObservations, marketBatches } from "../../src/db/schema.ts";
import { initializeMarket } from "../../src/market/sources.ts";
import { importCatalog } from "../../src/market/catalog.ts";

test("catalog import atomically creates observations and safe evidence, and replays idempotently", async () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    const input = { source: "hongguo", content: readFileSync("test/fixtures/market/hongguo.html", "utf8"),
      format: "html" as const, observedAt: "2026-09-11T08:00:00Z", origin: "fixture" as const };
    const first = await importCatalog(db, input);
    expect(first.items).toBe(2);
    expect((await importCatalog(db, input)).reused).toBe(true);
    const rows = db.select().from(marketObservations).all();
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.payload.facts.length === 0 && row.market === "unknown" && row.origin === "fixture")).toBe(true);
    expect(db.select().from(marketEvidence).all()).toHaveLength(2);
    expect(JSON.stringify(db.select().from(marketEvidence).all())).not.toContain("<html");
    await expect(importCatalog(db, { ...input, content: "<html>Login required</html>" })).rejects.toThrow("No parseable");
    expect(db.select().from(marketBatches).all()).toHaveLength(1);
    // A changed title at the same source/time is conflicting evidence, not
    // permission to mutate the prior observation or leave half a new batch.
    await expect(importCatalog(db, { ...input, content: input.content.replaceAll("示例短剧甲", "Different title") })).rejects.toThrow();
    expect(db.select().from(marketBatches).all()).toHaveLength(1);
    expect(db.select().from(marketEvidence).all()).toHaveLength(2);
  } finally { db.$client.close(); }
});
