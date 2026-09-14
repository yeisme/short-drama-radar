import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { openDb } from "../../src/db/client.ts";
import { marketEvidence, marketObservations } from "../../src/db/schema.ts";
import { initializeMarket } from "../../src/market/sources.ts";
import { importCatalog } from "../../src/market/catalog.ts";
import { listWorkMappings } from "../../src/market/identity.ts";

// Task 1.6: hongguo catalog fixture and parsing. Series identity and the
// category/episode fields stay traceable; catalog presence and ordering are
// never presented as audience heat.

const fields = () => readFileSync("test/fixtures/market/hongguo-fields.html", "utf8");

test("hongguo parsing keeps series identity, categories and episode counts traceable", async () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    await importCatalog(db, { source: "hongguo", content: fields(), format: "html", observedAt: "2026-09-10T08:00:00Z", origin: "fixture" });
    const rows = db.select().from(marketObservations).all().map(row => row.payload);
    expect(rows).toHaveLength(4);
    // Stable series ids; the episode suffix never leaks into the title.
    const byId = Object.fromEntries(rows.map(row => [row.source_item_id, row]));
    expect(byId["7574794690361297951"].title).toBe("示例都市剧乙");
    expect(byId["7574794690361297952"].title).toBe("示例逆袭剧");
    // Episode counts are explicit cumulative catalog facts.
    const episodes = rows.map(row => row.facts.find(fact => fact.name === "episode_count")).filter(Boolean);
    expect(episodes.map(fact => fact!.value).sort((a, b) => a - b)).toEqual([12, 80]);
    for (const fact of episodes) {
      expect(fact!.basis).toBe("cumulative");
      expect(fact!.unit).toBe("episodes");
      expect(fact!.definition_version).toBe("catalog-fields.v1");
    }
    // Categories map through the versioned zh table; unmapped labels keep
    // the raw text in evidence and stay unknown as topics.
    expect(byId["7574794690361297950"].topics).toEqual(["urban_power"]);
    expect(byId["7574794690361297953"].topics).toEqual(["suspense"]);
    expect(byId["7574794690361297952"].topics).toEqual([]);
    const evidence = db.select().from(marketEvidence).all();
    const unmapped = evidence.find(row => row.payload.category_label === "逆袭爽文");
    expect(unmapped!.payload.episode_count).toBe(12);
    expect(evidence.every(row => row.payload.origin === "fixture")).toBe(true);
    // Identity traceability: every series has a candidate mapping bound to
    // the stored evidence, never a guessed canonical ref.
    const works = listWorkMappings(db, "candidate");
    expect(works).toHaveLength(4);
    expect(works.every(work => work.canonical_work_ref === null && work.supporting_evidence_refs.length === 1)).toBe(true);
    expect(new Set(works.map(work => work.supporting_evidence_refs[0]))).toEqual(new Set(rows.map(row => row.evidence_refs[0])));
  } finally { db.$client.close(); }
});

test("catalog presence and directory order never become audience heat", async () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    const receipt = await importCatalog(db, { source: "hongguo", content: fields(), format: "html", observedAt: "2026-09-10T08:00:00Z", origin: "fixture" });
    // Directory order is not a rank: items are stored sorted by stable id
    // and no rank/placement fact is invented from page position.
    expect(receipt.limitations.some(line => line.includes("not audience demand"))).toBe(true);
    const rows = db.select().from(marketObservations).all().map(row => row.payload);
    expect(rows.every(row => row.facts.every(fact => fact.basis !== "rank" && fact.basis !== "placement"))).toBe(true);
    // A reordered page is the same sample: swapping plain work links (no
    // section headings involved) reuses the same batch instead of counting
    // a second catalog sample.
    const plain = [
      "[作品甲](https://novelquickapp.com/detail?series_id=7574794690361300001)",
      "[作品乙](https://novelquickapp.com/detail?series_id=7574794690361300002)",
    ].join("\n");
    await importCatalog(db, { source: "hongguo", content: plain, format: "markdown", observedAt: "2026-09-11T08:00:00Z", origin: "fixture" });
    const swapped = await importCatalog(db, { source: "hongguo", content: plain.split("\n").reverse().join("\n"), format: "markdown", observedAt: "2026-09-11T08:00:00Z", origin: "fixture" });
    expect(swapped.reused).toBe(true);
    expect(db.select().from(marketObservations).all()).toHaveLength(6);
  } finally { db.$client.close(); }
});
