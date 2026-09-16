import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db/client.ts";
import { marketObservationQuality, marketWorkGateDecisions, marketWorkReviewBatchReceipts } from "../../src/db/schema.ts";
import { initializeMarket } from "../../src/market/sources.ts";
import { evaluateAndRecordGate } from "../../src/market/gate.ts";
import { importCatalog } from "../../src/market/catalog.ts";
import { readFileSync } from "node:fs";
import { workSubjectRef } from "../../src/market/identity.ts";

const directories: string[] = [];
const databases: ReturnType<typeof openDb>[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.$client.close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function pathForDb() {
  const dir = mkdtempSync(join(tmpdir(), "radar-gate-storage-"));
  directories.push(dir);
  return join(dir, "radar.db");
}

test("gate tables are created on new and old databases, migrate is reentrant, and old rows survive", async () => {
  const path = pathForDb();
  const sqlite = new Database(path);
  sqlite.exec(`CREATE TABLE market_sources (
    ref TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(ref, revision)
  );`);
  sqlite.exec(`INSERT INTO market_sources (ref, revision, payload) VALUES ('legacy-source', 1, '{"spec":"radar.market_source.v1"}');`);
  sqlite.close();
  const db = openDb(path);
  databases.push(db);
  expect(db.select().from(marketWorkGateDecisions).all()).toEqual([]);
  expect(db.select().from(marketWorkReviewBatchReceipts).all()).toEqual([]);
  expect(db.select().from(marketObservationQuality).all()).toEqual([]);
  const raw = db.$client.query("SELECT ref FROM market_sources WHERE ref = 'legacy-source'").get() as { ref: string };
  expect(raw.ref).toBe("legacy-source");
  initializeMarket(db);
  const content = readFileSync("test/fixtures/market/hongguo-fields.html", "utf8");
  await importCatalog(db, { source: "hongguo", content, format: "html", observedAt: "2026-09-10T08:00:00Z", origin: "manual" });
  await importCatalog(db, { source: "hongguo", content, format: "html", observedAt: "2026-09-11T08:00:00Z", origin: "manual" });
  evaluateAndRecordGate(db, workSubjectRef("hongguo", "7574794690361297951"), { kind: "single" }, new Date("2026-09-12T08:00:00Z"));
  expect(db.select().from(marketWorkGateDecisions).all()).toHaveLength(1);
  expect(db.select().from(marketObservationQuality).all().length).toBeGreaterThan(0);
  db.$client.close();
  databases.pop();
  const reopened = openDb(path);
  databases.push(reopened);
  expect(reopened.select().from(marketWorkGateDecisions).all()).toHaveLength(1);
  expect(reopened.$client.query("SELECT ref FROM market_sources WHERE ref = 'legacy-source'").get()).toEqual({ ref: "legacy-source" });
});
