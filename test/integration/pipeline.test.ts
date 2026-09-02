import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db/client.ts";
import { dailyItems } from "../../src/db/schema.ts";
import { collect, defaultAdapters } from "../../src/pipeline/collect.ts";
import { scoreDay, WEIGHTS, spreadValue } from "../../src/pipeline/scoring.ts";
import { buildCard } from "../../src/pipeline/card.ts";

// Component-style integration: fixture-fed adapters through the real DB and
// the full collect -> score -> card path. Run evidence via scripts/integration-test-run.ts.
describe("daily pipeline (fixtures)", () => {
  test("collect -> score -> card produces up-to-Top5 confidence-gated payload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "radar-it-"));
    const db = openDb(join(dir, "test.db"));
    const fixtureDir = new URL("../fixtures", import.meta.url).pathname;
    const now = new Date("2026-08-29T08:30:00Z");

    const collectSummary = await collect(db, defaultAdapters(), {
      firecrawlBaseUrl: "http://unused",
      agentReachBin: "unused",
      timeoutMs: 5_000,
      fixtureDir,
      accountsPath: join(dir, "accounts.json"), // absent pool: Layer 2 degrades loudly
    }, now);
    expect(collectSummary.items).toBe(15); // 5+4 Layer 0 fixtures + 3+3 Layer 1 fixtures
    // Layer 1 fixture feeds succeed; Layer 2 is skipped explicitly in fixture mode.
    expect(collectSummary.degradedLayers).toContain("playwright-browser-douyin");
    expect(collectSummary.degradedLayers).toContain("playwright-browser-xiaohongshu");
    expect(collectSummary.degradedLayers).not.toContain("agent-reach-xhs");
    expect(collectSummary.degradedLayers).not.toContain("douyin-signed-api");

    const scoreSummary = await scoreDay(db, "2026-08-29");
    expect(scoreSummary.scored).toBe(15);

    const rows = db.select().from(dailyItems).all();
    for (const r of rows) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(100);
    }

    const card = buildCard(db, "2026-08-29", now);
    expect(card.contract).toBe("short-drama-radar.card.v1");
    expect(card.top.douyin.length).toBe(3);
    expect(card.top.xiaohongshu.length).toBe(3); // Layer 0 confidence=40 stays out of automatic card entry.
    expect(card.sourceStatus.notes.join(" ")).toContain("low-confidence candidates excluded");
    for (const item of [...card.top.douyin, ...card.top.xiaohongshu]) {
      expect(item.confidence).toBeGreaterThanOrEqual(60);
    }
    for (const item of card.top.douyin) {
      expect(item.tags.topics.length).toBeGreaterThan(0);
    }
  });
});

describe("spreadValue metric policy", () => {
  test("douyin prefers explicit like count, never fabricates plays", () => {
    expect(spreadValue("douyin", { like_count: 120 })).toBe(120);
    expect(spreadValue("douyin", {})).toBe(0);
  });
  test("xiaohongshu uses engagement increments as proxy", () => {
    expect(spreadValue("xiaohongshu", { like_delta: 10, collect_delta: 5, comment_delta: 2 })).toBe(17);
  });
  test("weights sum to 1", () => {
    expect(WEIGHTS.spread + WEIGHTS.topic + WEIGHTS.hook + WEIGHTS.emotion).toBe(1);
  });
});
