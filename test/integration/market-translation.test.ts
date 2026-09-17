import { afterEach, expect, test } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type RadarDb } from "../../src/db/client.ts";
import { initializeMarket, registerSourceCandidate, updateSettings } from "../../src/market/sources.ts";
import { importCatalog } from "../../src/market/catalog.ts";
import { listWorkMappings, workMapping } from "../../src/market/identity.ts";
import { recordTitleTranslation, readTitleTranslation, listChineseReading } from "../../src/market/translation.ts";
import { validateEnvelope } from "../../src/output/envelope.ts";

const databases: ReturnType<typeof openDb>[] = [], homes: string[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.$client.close()); homes.splice(0).forEach(h => rmSync(h, { recursive: true, force: true })); });
const html = readFileSync("test/fixtures/market/reelshort-ja-fields.html", "utf8");
async function setup(path = ":memory:") {
  const db = openDb(path); databases.push(db); initializeMarket(db);
  registerSourceCandidate(db, { source_ref: "reelshort-ja", publisher_group: "reelshort", locale: "ja", markets: ["JP"] });
  await importCatalog(db, { source: "reelshort-ja", content: html, format: "html", observedAt: "2026-09-17T00:00:00Z", origin: "fixture" });
  const work = listWorkMappings(db).find(w => w.original_title === "架空の物語")!;
  return { db, work };
}
function input(work: ReturnType<typeof listWorkMappings>[number]) {
  return { work_ref: work.platform_work_ref, work_revision: work.mapping_revision, revision: 0,
    target_locale: "zh-Hans" as const, translated_title: "虚构的故事", method: "agent" as const, translator_ref: "fixture-agent", key: "translate-1" };
}

test("translation history, replay and Chinese variants never overwrite identity", async () => {
  const { db, work } = await setup(), args = input(work);
  expect(readTitleTranslation(db, work.platform_work_ref, "zh-Hans").status).toBe("missing");
  const first = recordTitleTranslation(db, args);
  expect(first.translation.review_status).toBe("unreviewed");
  expect(recordTitleTranslation(db, args).reused).toBe(true);
  expect(() => recordTitleTranslation(db, { ...args, translated_title: "Changed" })).toThrow("different input");
  expect(() => recordTitleTranslation(db, { ...args, key: "new" })).toThrow("revisions");
  expect(() => recordTitleTranslation(db, { ...args, revision: 1, key: "correction" })).toThrow("reason");
  recordTitleTranslation(db, { ...args, target_locale: "zh-Hant", key: "traditional", translated_title: "虛構的故事" });
  const second = recordTitleTranslation(db, { ...args, revision: 1, key: "correction", translated_title: "一个虚构故事", reason: "Improve reading" });
  expect(second.translation.revision).toBe(2);
  expect(readTitleTranslation(db, work.platform_work_ref, "zh-Hans", 1).translation).toEqual(first.translation);
  expect(readTitleTranslation(db, work.platform_work_ref, "zh-Hant").display_title).toBe("虛構的故事");
  expect(workMapping(db, work.platform_work_ref)).toEqual(work);
});

test("source title changes invalidate a translation and old replay does not revive it", async () => {
  const { db, work } = await setup(), args = input(work);
  recordTitleTranslation(db, args);
  await importCatalog(db, { source: "reelshort-ja", content: html.replaceAll("架空の物語", "新しい物語"), format: "html", observedAt: "2026-09-17T01:00:00Z", origin: "fixture" });
  const read = readTitleTranslation(db, work.platform_work_ref, "zh-Hans");
  expect(read.status).toBe("stale"); expect(read.display_title).toBe("新しい物語");
  expect(recordTitleTranslation(db, args).source_current).toBe(false);
  expect(() => recordTitleTranslation(db, { ...args, revision: 1, key: "old-source", reason: "Outdated source" })).toThrow("revisions");
});

test("reobserving identical source text retains translation and reports missing entries", async () => {
  const { db, work } = await setup(); recordTitleTranslation(db, input(work));
  await importCatalog(db, { source: "reelshort-ja", content: html, format: "html", observedAt: "2026-09-17T01:00:00Z", origin: "fixture" });
  expect(readTitleTranslation(db, work.platform_work_ref, "zh-Hans").status).toBe("current");
  const listing = listChineseReading(db, { language: "zh-Hans", source: "reelshort-ja", limit: 1 });
  expect(listing.items).toHaveLength(1); expect(listing.truncated).toBe(true);
  expect(listChineseReading(db, { language: "zh-Hans", source: "reelshort-ko" }).items).toEqual([]);
});

test("policy and sensitive-input checks apply to reading, writes and replay", async () => {
  const { db, work } = await setup(), args = input(work);
  expect(() => recordTitleTranslation(db, { ...args, translated_title: "token=synthetic-secret" })).toThrow("credential");
  recordTitleTranslation(db, args);
  updateSettings(db, 1, { blocked_topics: ["fantasy"] });
  expect(() => readTitleTranslation(db, work.platform_work_ref, "zh-Hans")).toThrow("blocked");
  expect(() => recordTitleTranslation(db, args)).toThrow("blocked");
  expect(listChineseReading(db, { language: "zh-Hans" }).items).toEqual([]);
});

test("real CLI uses shared Chinese-reading output modes and remains local", async () => {
  const home = mkdtempSync(join(tmpdir(), "radar-translation-")); homes.push(home);
  const { work } = await setup(join(home, "radar.db"));
  const run = (...words: string[]) => Bun.spawnSync([process.execPath, "run", "src/cli.ts", "market", ...words], {
    cwd: join(import.meta.dir, "../.."), env: { ...process.env, RADAR_HOME: home, RADAR_DB_PATH: join(home, "radar.db"), RADAR_CONFIG_PATH: join(home, "config.json") } });
  const add = run("translation", "add", "--work", work.platform_work_ref, "--work-revision", String(work.mapping_revision), "--revision", "0",
    "--language", "zh-Hans", "--text", "虚构的故事", "--method", "agent", "--translator", "test-session", "--key", "cli-1", "--json");
  expect(add.exitCode).toBe(0);
  expect(validateEnvelope(JSON.parse(add.stdout.toString())).ok).toBe(true);
  for (const mode of ["--json", "--agent", "--explain", "--events"]) {
    const reading = run("reading", "list", "--language", "zh-Hans", mode);
    expect(reading.exitCode).toBe(0);
    if (mode === "--json") {
      const out = JSON.parse(reading.stdout.toString());
      expect(out.facts.external_collection).toBe(false);
      expect(out.data.items.some((i: { display_title: string }) => i.display_title === "虚构的故事")).toBe(true);
    }
    if (mode === "--events") expect(JSON.parse(reading.stdout.toString().trim().split("\n").at(-1)!).event).toBe("end");
  }
  expect(run("translation", "add", "--text", "must-not-leak", "--bad", "--json").exitCode).not.toBe(0);
  const help = run("reading", "list", "--language", "zh", "--json");
  expect(help.exitCode).not.toBe(0);
});
