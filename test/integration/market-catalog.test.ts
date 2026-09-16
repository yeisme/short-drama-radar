import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db/client.ts";
import { marketEvidence, marketObservations, marketBatches } from "../../src/db/schema.ts";
import { initializeMarket } from "../../src/market/sources.ts";
import { importCatalog } from "../../src/market/catalog.ts";
import { observeCatalog } from "../../src/market/observe.ts";
import { listWorkMappings, workMapping, workSubjectRef } from "../../src/market/identity.ts";

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

// radar-hongguo-catalog-parsing-v1: fixture replay of the 2026-09-16 live
// page structure. Category coverage recovers through the page's own anchor
// tag spans, fixture origin never mixes with live, and evidence stays
// normalized (no raw HTML).
test("hongguo live-structure fixture replays with near-full category coverage", async () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    const content = readFileSync("test/fixtures/market/hongguo-live-2026-09-16.html", "utf8");
    const receipt = await importCatalog(db, { source: "hongguo", content, format: "html", observedAt: "2026-09-16T08:00:00Z", origin: "fixture" });
    expect(receipt.items).toBe(7);
    expect(receipt.field_coverage).toEqual({ category: 6, episode_count: 7 });
    const rows = db.select().from(marketObservations).all();
    expect(rows.every(row => row.origin === "fixture" && row.payload.origin === "fixture")).toBe(true);
    expect(rows.map(row => row.payload.title)).toContain("夺风华");
    expect(rows.every(row => !row.payload.title.includes("夺风华夺风华"))).toBe(true);
    const evidence = db.select().from(marketEvidence).all();
    expect(evidence).toHaveLength(7);
    expect(JSON.stringify(evidence)).not.toContain("<");
    expect(receipt.limitations.some(line => line.includes("hongguo-anchor-layout.v1"))).toBe(true);
    // Idempotent replay: the same cleaned sample reuses its batch.
    expect((await importCatalog(db, { source: "hongguo", content, format: "html", observedAt: "2026-09-16T08:00:00Z", origin: "fixture" })).reused).toBe(true);
    expect(db.select().from(marketBatches).all()).toHaveLength(1);
  } finally { db.$client.close(); }
});

// Resampling compatibility: a re-sample after the parsing fix mints a new
// batch and a new candidate mapping revision with the cleaned title, while
// the old glued-title observation and evidence stay readable unchanged.
test("resampling the same series keeps old observations immutable and advances the mapping revision", async () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    // The pre-fix sample shape: the glued anchor text became the title.
    const glued = "[夺风华夺风华古装重生逆袭日久生情](https://novelquickapp.com/detail?series_id=7680410161940286526)";
    await importCatalog(db, { source: "hongguo", content: glued, format: "markdown", observedAt: "2026-09-16T06:00:00Z", origin: "fixture" });
    const subject = workSubjectRef("hongguo", "7680410161940286526");
    expect(workMapping(db, subject)!.original_title).toBe("夺风华夺风华古装重生逆袭日久生情");
    expect(workMapping(db, subject)!.mapping_revision).toBe(1);
    // The cleaned resample of the same series id.
    const content = readFileSync("test/fixtures/market/hongguo-live-2026-09-16.html", "utf8");
    await importCatalog(db, { source: "hongguo", content, format: "html", observedAt: "2026-09-16T09:00:00Z", origin: "fixture" });
    const head = workMapping(db, subject)!;
    expect(head.original_title).toBe("夺风华");
    expect(head.mapping_revision).toBe(2);
    expect(head.mapping_status).toBe("candidate");
    // Revision 1 stays on record; the old observation payload is untouched.
    expect(workMapping(db, subject, 1)!.original_title).toBe("夺风华夺风华古装重生逆袭日久生情");
    const titles = db.select().from(marketObservations).all().map(row => [row.payload.observed_at, row.payload.title]);
    expect(titles).toContainEqual(["2026-09-16T06:00:00.000Z", "夺风华夺风华古装重生逆袭日久生情"]);
    expect(titles).toContainEqual(["2026-09-16T09:00:00.000Z", "夺风华"]);
    expect(db.select().from(marketBatches).all()).toHaveLength(2);
    expect(listWorkMappings(db, "candidate").filter(mapping => mapping.original_title === "夺风华")).toHaveLength(1);
  } finally { db.$client.close(); }
});

// The observe fixture path replays the live-structure fixture offline:
// readiness stays planned, origin stays fixture, coverage is visible.
test("observe --fixture replays the live-structure fixture without promoting readiness", async () => {
  const db = openDb(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "radar-hongguo-fixture-"));
  try {
    initializeMarket(db);
    mkdirSync(join(dir, "market"), { recursive: true });
    writeFileSync(join(dir, "market", "hongguo-fields.html"), readFileSync("test/fixtures/market/hongguo-live-2026-09-16.html", "utf8"));
    const receipt = await observeCatalog(db, {
      source: "hongguo", mode: "verify-sample", fixture: true, fixtureDir: dir,
      observedAt: "2026-09-16T10:00:00Z",
    });
    expect(receipt.origin).toBe("fixture");
    expect(receipt.items).toBe(7);
    expect(receipt.field_coverage).toEqual({ category: 6, episode_count: 7 });
    expect(receipt.readiness_unchanged).toBe("planned");
    expect(receipt.skipped_links).toEqual({ foreign_or_unsafe_link: 2, no_work_identity: 5, title_invalid: 0 });
    expect(db.select().from(marketBatches).all().every(row => row.origin === "fixture")).toBe(true);
  } finally { db.$client.close(); }
});
