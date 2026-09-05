import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db/client.ts";
import { dailyItems, runs } from "../../src/db/schema.ts";
import { collect } from "../../src/pipeline/collect.ts";
import { makeManualImportAdapter, parseImportCsv } from "../../src/adapters/manual-import.ts";

describe("manual import CSV parsing (B4)", () => {
  test("required columns + optional metrics map to normalized keys", () => {
    const { items, badRows } = parseImportCsv(
      "platform,title,url,publishedAt,author,likes,comments,collects,shares,contentId\n" +
        'xiaohongshu," revenge, boss ",https://x/1,1758931200000,某作者,1200,88,340,12,x1\n',
    );
    expect(badRows).toEqual([]);
    expect(items).toHaveLength(1);
    const it = items[0]!;
    expect(it.contentId).toBe("x1");
    expect(it.title).toBe("revenge, boss"); // RFC4180 comma survives inside quotes; cells are trimmed
    expect(it.publishedAt).toBe("2025-09-27T00:00:00.000Z"); // epoch ms -> ISO
    expect(it.authorName).toBe("某作者");
    expect(it.metrics).toEqual({ liked_count: 1200, comment_count: 88, collected_count: 340, share_count: 12 });
    expect(it.confidence).toBe(50);
  });

  test("missing contentId derives a stable id from platform+url", () => {
    const a = parseImportCsv("platform,title,url\ndouyin,t,https://x/1\n");
    const b = parseImportCsv("platform,title,url\ndouyin,t,https://x/1\n");
    expect(a.items[0]!.contentId).toMatch(/^manual-[0-9a-f]{20}$/);
    expect(a.items[0]!.contentId).toBe(b.items[0]!.contentId);
  });

  test("bad rows are reported with line numbers, never dropped silently", () => {
    const { items, badRows } = parseImportCsv(
      "platform,title,url\nxiaohongshu,ok,https://x/1\nweibo,bad-platform,https://x/2\nxiaohongshu,,https://x/3\nxiaohongshu,ok2,https://x/4\n",
    );
    // Only the invalid-platform and empty-title rows are rejected.
    expect(items).toHaveLength(2);
    expect(badRows).toEqual([
      { row: 3, reason: "invalid platform 'weibo' (expected douyin|xiaohongshu)" },
      { row: 4, reason: "empty title" },
    ]);
  });

  test("negative or fractional metrics reject the row", () => {
    const { badRows } = parseImportCsv("platform,title,url,likes\nxhs,t,https://x/1,-5\nxhs,t2,https://x/2,1.5\n");
    expect(badRows.map((b) => b.row)).toEqual([2, 3]);
  });

  test("missing required header column fails the whole file loudly", () => {
    expect(() => parseImportCsv("platform,title\ndouyin,t\n")).toThrow("missing required column 'url'");
  });

  test("BOM and CRLF are tolerated", () => {
    const { items } = parseImportCsv("﻿platform,title,url\r\ndouyin,t,https://x/1\r\n");
    expect(items).toHaveLength(1);
  });
});

describe("manual import through the pipeline (B4 integration)", () => {
  const ctx = { firecrawlBaseUrl: "http://unused", agentReachBin: "unused", timeoutMs: 1000 };

  test("import writes layer-3 rows, marks them degraded, and records an import receipt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "radar-import-"));
    writeFileSync(join(dir, "in.csv"), "platform,title,url,likes\ndouyin,manual item,https://x/m1,500\nweibo,bad-platform,https://x/bad\n");
    const db = openDb(join(dir, "t.db"));
    const summary = await collect(db, [makeManualImportAdapter(join(dir, "in.csv"))], ctx, new Date("2026-09-05T08:00:00Z"));
    expect(summary.items).toBe(1); // the weibo row is rejected, not imported
    expect(summary.degradedLayers).toContain("manual-import");
    expect(summary.errors.some((e) => e.includes("row 3"))).toBe(true);

    const rows = db.select().from(dailyItems).all();
    expect(rows).toHaveLength(1);
    const manual = rows.find((r) => r.url === "https://x/m1")!;
    expect(manual.sourceLayer).toBe(3);
    expect(manual.degraded).toBe(1); // Layer 3 is an explicit degraded source
    expect(JSON.parse(manual.metricsJson)).toMatchObject({ liked_count: 500 });
    expect(manual.confidence).toBe(50);

    // An existing Layer 1 row keeps ownership when the same content is imported.
    const db2 = openDb(join(mkdtempSync(join(tmpdir(), "radar-import-")), "t.db"));
    const api = { name: "douyin-signed-api", layer: 1, platform: "douyin" as const, fetch: async () => ({ source: "douyin-signed-api", layer: 1, items: [{ platform: "douyin" as const, contentId: "same", title: "api", url: "https://x/1", metrics: { digg_count: 900 }, confidence: 80 }], degraded: false, errors: [] }) };
    await collect(db2, [api], ctx, new Date("2026-09-05T08:00:00Z"));
    const csv = "platform,title,url,contentId,likes\ndouyin,manual,https://x/1,same,100\n";
    writeFileSync(join(tmpdir(), "radar-import-merge.csv"), csv);
    await collect(db2, [makeManualImportAdapter(join(tmpdir(), "radar-import-merge.csv"))], ctx, new Date("2026-09-05T08:30:00Z"));
    const merged = db2.select().from(dailyItems).all()[0]!;
    expect(merged.sourceLayer).toBe(1); // API data owns the row over manual import
    expect(JSON.parse(merged.metricsJson)).toMatchObject({ digg_count: 900, liked_count: 100 }); // manual fills gaps
  });
});
