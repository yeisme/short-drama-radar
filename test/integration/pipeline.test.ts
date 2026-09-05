import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db/client.ts";
import { dailyItems } from "../../src/db/schema.ts";
import { collect, defaultAdapters } from "../../src/pipeline/collect.ts";
import type { Adapter, RawItem } from "../../src/adapters/types.ts";
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
  test("xiaohongshu reads the normalized comment_count key (B2 regression: 1540 vs 1628)", () => {
    // Exact keys the agentreach-xhs normalizer writes; the old code read
    // `comments_count` and silently dropped comment engagement entirely.
    expect(spreadValue("xiaohongshu", { liked_count: 1200, collected_count: 340, comment_count: 88 })).toBe(1628);
  });
  test("deltas take precedence over absolute totals when present (B3)", () => {
    expect(spreadValue("douyin", { digg_delta: 250, digg_count: 15000 })).toBe(250);
    expect(spreadValue("xiaohongshu", { like_delta: 120, liked_count: 1320, collected_count: 360, comment_count: 100 })).toBe(120);
  });
  test("weights sum to 1", () => {
    expect(WEIGHTS.spread + WEIGHTS.topic + WEIGHTS.hook + WEIGHTS.emotion).toBe(1);
  });
});

describe("cross-layer dedupe and re-observation (authority order)", () => {
  function adapter(source: string, layer: number, items: RawItem[]): Adapter {
    return { name: source, layer, platform: items[0]?.platform ?? "douyin", fetch: async () => ({ source, layer, items, degraded: false, errors: [] }) };
  }
  const ctx = { firecrawlBaseUrl: "http://unused", agentReachBin: "unused", timeoutMs: 1000 };
  const item = (platform: "douyin" | "xiaohongshu", contentId: string, over: Partial<RawItem> = {}): RawItem => ({
    platform, contentId, title: `t-${contentId}`, url: `https://x/${contentId}`, metrics: {}, confidence: 40, ...over,
  });
  const open = () => openDb(join(mkdtempSync(join(tmpdir(), "radar-dedup-")), "t.db"));

  test("Layer 1 beats Layer 0 for the same content id; the loser fills field gaps (B1)", async () => {
    const db = open();
    const now = new Date("2026-09-05T08:10:00Z");
    await collect(db, [
      adapter("firecrawl-douyin", 0, [item("douyin", "701", { title: "", url: "https://l0/701", confidence: 40 })]),
      adapter("douyin-signed-api", 1, [item("douyin", "701", { title: "L1 title", url: "", metrics: { digg_count: 15000, comment_count: 1200 }, confidence: 80 })]),
    ], ctx, now);
    const rows = db.select().from(dailyItems).all();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.sourceLayer).toBe(1);
    expect(row.confidence).toBe(80); // clears the 60 card gate — hot items no longer locked out
    expect(JSON.parse(row.metricsJson)).toMatchObject({ digg_count: 15000, comment_count: 1200 });
    expect(row.title).toBe("L1 title"); // winner owns identity fields
    expect(row.url).toBe("https://l0/701"); // loser filled the missing url
  });

  test("L2 beats L0 but loses to L1 (authority is not layer number order)", async () => {
    const db = open();
    await collect(db, [
      adapter("firecrawl-xhs", 0, [item("xiaohongshu", "x1", { confidence: 40 })]),
      adapter("playwright-browser-xhs", 2, [item("xiaohongshu", "x1", { title: "browser title", confidence: 50 })]),
    ], ctx, new Date("2026-09-05T08:10:00Z"));
    const a = db.select().from(dailyItems).all()[0]!;
    expect(a.sourceLayer).toBe(2);
    expect(a.title).toBe("browser title");
    expect(a.degraded).toBe(1); // owning layer 2 is a degraded source

    const db2 = open();
    await collect(db2, [
      adapter("playwright-browser-xhs", 2, [item("xiaohongshu", "x1", { title: "browser", confidence: 50 })]),
      adapter("agent-reach-xhs", 1, [item("xiaohongshu", "x1", { title: "api", metrics: { liked_count: 10 }, confidence: 80 })]),
    ], ctx, new Date("2026-09-05T08:10:00Z"));
    const b = db2.select().from(dailyItems).all()[0]!;
    expect(b.sourceLayer).toBe(1); // L1 signed API keeps ownership over the browser view
    expect(b.degraded).toBe(0);
  });

  test("re-observation from a lower-authority layer cannot clobber metrics or fake freshness (B6)", async () => {
    const db = open();
    const t0 = new Date("2026-09-05T08:10:00Z");
    await collect(db, [adapter("douyin-signed-api", 1, [item("douyin", "701", { url: "", metrics: { digg_count: 15000 }, confidence: 80 })])], ctx, t0);
    // 2h later a Layer 0 pass sees the same content with no metrics but a url.
    const t1 = new Date("2026-09-05T10:10:00Z");
    await collect(db, [adapter("firecrawl-douyin", 0, [item("douyin", "701", { url: "https://l0/701", confidence: 40 })])], ctx, t1);
    const row = db.select().from(dailyItems).all()[0]!;
    expect(JSON.parse(row.metricsJson)).toMatchObject({ digg_count: 15000 }); // preserved, no clobber
    expect(row.sourceLayer).toBe(1); // ownership unchanged
    expect(row.confidence).toBe(80);
    expect(row.url).toBe("https://l0/701"); // gap filled by the lower layer
    expect(row.updatedAt).toBe(t1.toISOString()); // the gap-fill is a real change and refreshes honestly
  });

  test("a no-op re-observation writes nothing; a later pass records zero deltas honestly", async () => {
    const db = open();
    const t0 = new Date("2026-09-05T08:10:00Z");
    const it = item("douyin", "701", { metrics: { digg_count: 100 }, confidence: 80 });
    // Identical payload at the identical instant: nothing changes, no write.
    await collect(db, [adapter("douyin-signed-api", 1, [it])], ctx, t0);
    await collect(db, [adapter("douyin-signed-api", 1, [it])], ctx, t0);
    let row = db.select().from(dailyItems).all()[0]!;
    expect(row.updatedAt).toBe(t0.toISOString());
    expect(JSON.parse(row.metricsJson)).not.toHaveProperty("digg_delta");
    // A genuinely later observation with identical totals is real evidence
    // (flat engagement over the window) and IS written with zero deltas.
    const t1 = new Date("2026-09-05T09:10:00Z");
    await collect(db, [adapter("douyin-signed-api", 1, [it])], ctx, t1);
    row = db.select().from(dailyItems).all()[0]!;
    expect(row.updatedAt).toBe(t1.toISOString());
    expect(JSON.parse(row.metricsJson)).toMatchObject({ digg_delta: 0, delta_window_hours: 1 });
  });

  test("second same-layer pass produces engagement deltas with the observation window (B3 producer)", async () => {
    const db = open();
    await collect(db, [adapter("agent-reach-xhs", 1, [item("xiaohongshu", "x9", { metrics: { liked_count: 1200, collected_count: 340, comment_count: 88 }, confidence: 80 })])], ctx, new Date("2026-09-05T08:10:00Z"));
    await collect(db, [adapter("agent-reach-xhs", 1, [item("xiaohongshu", "x9", { metrics: { liked_count: 1320, collected_count: 360, comment_count: 100 }, confidence: 80 })])], ctx, new Date("2026-09-05T10:10:00Z"));
    const metrics = JSON.parse(db.select().from(dailyItems).all()[0]!.metricsJson) as Record<string, number>;
    expect(metrics).toMatchObject({ liked_count: 1320, collected_count: 360, comment_count: 100 });
    expect(metrics["like_delta"]).toBe(120);
    expect(metrics["collect_delta"]).toBe(20);
    expect(metrics["comment_delta"]).toBe(12);
    expect(metrics["delta_window_hours"]).toBe(2);
  });
});

describe("daily run writes collect-kind receipts (B5)", () => {
  test("radar run leaves a collect receipt visible to card/health readers", () => {
    const home = mkdtempSync(join(tmpdir(), "radar-run-receipt-"));
    const env = { ...process.env, RADAR_HOME: home, RADAR_DB_PATH: join(home, "radar.db"), RADAR_FIXTURE_DIR: new URL("../fixtures", import.meta.url).pathname };
    const run = Bun.spawnSync([process.execPath, join(import.meta.dir, "../../src/cli.ts"), "run", "--json"], { env });
    if (run.exitCode !== 0) throw new Error(run.stderr.toString());
    const runsJson = Bun.spawnSync([process.execPath, join(import.meta.dir, "../../src/cli.ts"), "runs", "--json"], { env });
    const payload = JSON.parse(runsJson.stdout.toString());
    const kinds = payload.data.map((r: { kind: string }) => r.kind);
    expect(kinds).toContain("collect"); // card.ts/health.ts only ever scanned kind="collect"
    expect(kinds).toContain("daily");
  });
});
