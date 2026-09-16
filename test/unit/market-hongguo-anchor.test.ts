import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { openDb } from "../../src/db/client.ts";
import { marketEvidence, marketObservations } from "../../src/db/schema.ts";
import { initializeMarket } from "../../src/market/sources.ts";
import { HONGGUO_ANCHOR_LAYOUT_VERSION, importCatalog, parseCatalog } from "../../src/market/catalog.ts";

// radar-hongguo-catalog-parsing-v1: the 2026-09-16 live sample exposed glued
// anchor text (title repeated twice + genre tag string) and 0/24 category
// coverage. hongguo-anchor-layout.v1 splits the work card structure
// deterministically; labels only ever come from the page itself.

const live = () => readFileSync("test/fixtures/market/hongguo-live-2026-09-16.html", "utf8");
const byId = (result: Awaited<ReturnType<typeof parseCatalog>>, id: string) => result.items.find(item => item.id === id)!;

test("hongguo-anchor-layout.v1 splits glued titles and page tag strings", async () => {
  const result = await parseCatalog("hongguo", live(), "html");
  expect(result.status).toBe("parsed");
  expect(result.items).toHaveLength(7);
  // The spec scenario: title repeated twice plus a tag string splits into a
  // clean title and the page's own labels, never a guessed genre.
  const duofenghua = byId(result, "7680410161940286526");
  expect(duofenghua.title).toBe("夺风华");
  expect(duofenghua.labels).toEqual(["古装", "重生逆袭", "日久生情"]);
  expect(duofenghua.category).toBe("古装");
  expect(duofenghua.episode_count).toBe(78);
  // No stored title keeps the doubled-title glue.
  expect(result.items.every(item => !item.title.includes(item.title.slice(0, 2).repeat(2)))).toBe(true);
  expect(result.items.map(item => item.title)).not.toContain("夺风华夺风华古装重生逆袭日久生情");
  // Category coverage counts works with any page genre label; only the
  // structurally label-less plain-text anchor stays unknown.
  expect(result.field_coverage).toEqual({ category: 6, episode_count: 7 });
});

test("duplicate and empty tag spans are normalized, never stored twice or blank", async () => {
  const result = await parseCatalog("hongguo", live(), "html");
  expect(byId(result, "7682026443286531097").labels).toEqual(["都市", "都市日常"]);
  expect(byId(result, "7678995911824903193").labels).toEqual(["都市", "都市日常", "网络暴力"]);
});

test("anchor-own labels win over the section heading; plain anchors keep the fallback", async () => {
  const result = await parseCatalog("hongguo", live(), "html");
  // 破茧！ sits under the h3 悬疑 heading, but its card tags stay authoritative.
  const pojian = byId(result, "7680816807053102104");
  expect(pojian.labels).toEqual(["爱情", "都市爱情", "日久生情"]);
  expect(pojian.category).toBe("爱情");
  // A plain text anchor without the card structure falls back to splitTitle:
  // episode suffix stripped, no labels invented, category stays null.
  const plain = byId(result, "7574794690361400001");
  expect(plain.title).toBe("示例纯文本剧");
  expect(plain.labels).toEqual([]);
  expect(plain.category).toBeNull();
  expect(plain.episode_count).toBe(12);
});

test("structure mismatch keeps the raw title and produces no labels", async () => {
  // A conflicting img alt means the card structure was misread: the rule
  // must not half-split or guess.
  const conflicting = '<a href="/detail?series_id=7574794690361400010"><img alt="完全不同的剧名" src="/c.png"/><p>示例冲突剧</p><span>都市</span></a>';
  const result = await parseCatalog("hongguo", conflicting, "html");
  expect(result.items).toHaveLength(1);
  // Fallback keeps the raw anchor text as collected (alt prefix included).
  expect(result.items[0].title).toBe("完全不同的剧名示例冲突剧都市");
  expect(result.items[0].labels).toEqual([]);
  expect(result.field_coverage.category).toBe(0);
  // A single title mention with a tag string is not the doubled-title
  // layout: fall back to the raw cleaned text with no labels.
  const single = '<a href="/detail?series_id=7574794690361400011"><p>示例单词剧</p><span>都市</span></a>';
  const singleResult = await parseCatalog("hongguo", single, "html");
  expect(singleResult.items[0].title).toBe("示例单词剧都市");
  expect(singleResult.items[0].labels).toEqual([]);
});

test("page transport noise (NUL padding, split whitespace) is stripped deterministically", async () => {
  // The live page pads tag text with NUL bytes and may split the doubled
  // title across whitespace; the visible label/title is the stripped text.
  const padded = '<a href="/detail?series_id=7574794690361400012"><img alt="示例噪声 剧" src="/c.png"/><p>全30集</p><p>示例噪声剧</p><span>爱\x00\x00情</span><span>都市爱情</span></a>';
  const result = await parseCatalog("hongguo", padded, "html");
  expect(result.items[0].title).toBe("示例噪声剧");
  expect(result.items[0].labels).toEqual(["爱情", "都市爱情"]);
  expect(result.items[0].episode_count).toBe(30);
});

test("an anchor binds at most 8 page labels", async () => {
  const spans = Array.from({ length: 10 }, (_, i) => `<span>标签${i}</span>`).join("");
  const html = `<a href="/detail?series_id=7574794690361400013"><img alt="示例多标签剧" src="/c.png"/><p>示例多标签剧</p>${spans}</a>`;
  const result = await parseCatalog("hongguo", html, "html");
  expect(result.items[0].labels).toHaveLength(8);
});

test("skip attribution is explainable and never echoes full URLs", async () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    const receipt = await importCatalog(db, { source: "hongguo", content: live(), format: "html", observedAt: "2026-09-16T08:00:00Z", origin: "fixture" });
    expect(receipt.skipped_links).toEqual({ foreign_or_unsafe_link: 2, no_work_identity: 5, title_invalid: 0 });
    const attribution = receipt.limitations.filter(line => line.startsWith("Skipped"));
    expect(attribution.some(line => line.includes("category_or_genre_filter x2") && line.includes("home_or_navigation x1") && line.includes("ranking_page x1") && line.includes("pagination x1"))).toBe(true);
    expect(attribution.some(line => line.includes("foreign_host x1") && line.includes("non_https_protocol x1"))).toBe(true);
    // The label source is named with its rule version; suspicious URLs are not.
    expect(receipt.limitations.some(line => line.includes(HONGGUO_ANCHOR_LAYOUT_VERSION))).toBe(true);
    const blob = JSON.stringify(receipt);
    expect(blob).not.toContain("beian.miit.gov.cn");
    expect(blob).not.toContain("mailto:");
  } finally { db.$client.close(); }
});

test("page labels flow into topics, evidence and immutable observations", async () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    const receipt = await importCatalog(db, { source: "hongguo", content: live(), format: "html", observedAt: "2026-09-16T08:00:00Z", origin: "fixture" });
    expect(receipt.field_coverage).toEqual({ category: 6, episode_count: 7 });
    const rows = db.select().from(marketObservations).all().map(row => row.payload);
    const byWork = Object.fromEntries(rows.map(row => [row.source_item_id, row]));
    // Mapped labels produce topics through the versioned zh mapping.
    expect(byWork["7680410161940286526"].topics).toEqual(["period_costume", "rebirth_comeback", "slow_burn_romance"]);
    expect(byWork["7680410161940286526"].title).toBe("夺风华");
    // Partially mapped labels keep mapped topics; the unmapped raw label is
    // retained in evidence instead of a guessed topic.
    expect(byWork["7574794690361400002"].topics).toEqual(["urban_power"]);
    const evidence = db.select().from(marketEvidence).all();
    const unmapped = evidence.find(row => row.payload.source_item_id === "7574794690361400002")!;
    expect(unmapped.payload.category_labels).toEqual(["都市", "示例未映射标签"]);
    expect(evidence.every(row => row.payload.origin === "fixture")).toBe(true);
    expect(JSON.stringify(evidence)).not.toContain("<");
  } finally { db.$client.close(); }
});
