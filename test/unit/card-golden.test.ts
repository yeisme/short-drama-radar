import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db/client.ts";
import { dailyItems, runs } from "../../src/db/schema.ts";
import { buildCard } from "../../src/pipeline/card.ts";
import { collect, defaultAdapters } from "../../src/pipeline/collect.ts";
import { scoreDay } from "../../src/pipeline/scoring.ts";

// Frozen compatibility baseline (task 0.3):
// 1. card.v1 payload shape + field semantics are permanent — golden snapshot.
// 2. The legacy 0.0.x envelope draft is migration evidence only; in-repo
//    consumers were migrated to the standard envelope in the same change.

describe("short-drama-radar.card.v1 golden", () => {
  test("payload shape and semantics stay frozen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "radar-golden-"));
    const db = openDb(join(dir, "t.db"));
    const fixtureDir = new URL("../fixtures", import.meta.url).pathname;
    const now = new Date("2026-08-29T08:59:00Z");
    await collect(db, defaultAdapters(), { firecrawlBaseUrl: "unused", agentReachBin: "unused", timeoutMs: 5_000, fixtureDir }, now);
    await scoreDay(db, "2026-08-29");
    const card = buildCard(db, "2026-08-29", now);

    // Top-level contract fields.
    expect(card.contract).toBe("short-drama-radar.card.v1");
    expect(Object.keys(card).sort()).toEqual(["contract", "date", "generatedAt", "sourceStatus", "top", "trends"]);

    // Item fields and ordering semantics.
    const item = card.top.douyin[0]!;
    expect(Object.keys(item).sort()).toEqual(["confidence", "contentId", "degraded", "isNew", "platform", "rank", "score", "tags", "title", "url"]);
    expect(item.rank).toBe(1);
    expect(item.platform).toBe("douyin");
    expect(item.degraded).toBe(false);
    expect(card.top.douyin.map((i) => i.score)).toEqual([...card.top.douyin.map((i) => i.score)].sort((a, b) => b - a));

    // Tags sub-object keys are frozen too.
    expect(Object.keys(item.tags).sort()).toEqual(["emotions", "hooks", "topics"]);

    // Deterministic date + generatedAt round-trip.
    expect(card.date).toBe("2026-08-29");
    expect(card.generatedAt).toBe(now.toISOString());

    // Golden digest over the semantic payload (excluding generatedAt).
    const { createHash } = await import("node:crypto");
    const payload = { ...card, generatedAt: "frozen" };
    const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    // Re-recorded during pre-release acceptance after enforcing the specified
    // confidence>=60 automatic-entry gate. Field/schema compatibility is unchanged.
    expect(digest).toBe("61daf9e41d477629e1e23784ffa3370771336ac6bde029e85964c22b5ba2feb3");
  });

  test("legacy 0.0.x envelope draft is preserved as evidence, not contract", async () => {
    const legacy = await Bun.file(new URL("../fixtures/envelope-legacy-0.0.1.json", import.meta.url)).json();
    expect(legacy["app"]).toBe("short-drama-radar");
    expect(Object.keys(legacy).sort()).toEqual(["_comment", "app", "command", "data", "errors", "ok"]);
    // The card payload it carried is the compatible part.
    expect(legacy["data"]["contract"]).toBe("short-drama-radar.card.v1");
  });

  test("confidence below 60 never enters the automatic card", () => {
    const dir = mkdtempSync(join(tmpdir(), "radar-card-gate-"));
    const db = openDb(join(dir, "t.db"));
    db.insert(dailyItems).values({
      date: "2026-08-31",
      platform: "douyin",
      contentId: "740000000000000001",
      title: "high confidence",
      url: "https://www.douyin.com/video/740000000000000001",
      metricsJson: "{}",
      score: 10,
      confidence: 60,
      updatedAt: "2026-08-31T08:00:00Z",
    }).run();
    db.insert(dailyItems).values({
      date: "2026-08-31",
      platform: "douyin",
      contentId: "2630652",
      title: "public hot topic",
      url: "https://www.douyin.com/hot/2630652/topic",
      metricsJson: "{}",
      score: 99,
      confidence: 40,
      updatedAt: "2026-08-31T08:00:00Z",
    }).run();
    const card = buildCard(db, "2026-08-31");
    expect(card.top.douyin.map((item) => item.contentId)).toEqual(["740000000000000001"]);
    expect(card.sourceStatus.notes.join(" ")).toContain("low-confidence candidates excluded");
  });

  test("failed collection layers propagate to sourceStatus even when surviving items are healthy", () => {
    const dir = mkdtempSync(join(tmpdir(), "radar-card-source-status-"));
    const db = openDb(join(dir, "t.db"));
    db.insert(runs).values({
      id: "collect-2026-08-31T08:10:00Z",
      kind: "collect",
      startedAt: "2026-08-31T08:10:00Z",
      finishedAt: "2026-08-31T08:11:00Z",
      status: "degraded",
      summaryJson: JSON.stringify({ degradedLayers: ["agent-reach-xhs"] }),
    }).run();
    const card = buildCard(db, "2026-08-31");
    expect(card.sourceStatus.degraded).toBe(true);
    expect(card.sourceStatus.notes.join(" ")).toContain("agent-reach-xhs");
  });
});

describe("in-repo envelope consumers (migrated)", () => {
  test("no code path still emits the legacy {ok, app, command, data, errors} envelope", async () => {
    const { globSync } = await import("node:fs");
    const offenders: string[] = [];
    for (const p of globSync("src/**/*.ts")) {
      const src = await Bun.file(p).text();
      if (/ok:\s*(errors|boolean|true)/.test(src) && /app:\s*"short-drama-radar"/.test(src)) offenders.push(p);
    }
    expect(offenders).toEqual([]);
  });
});
