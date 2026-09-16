import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { openDb } from "../../src/db/client.ts";
import { marketSyncState } from "../../src/db/schema.ts";

// Task 2.1: market_sync_state exists on new databases, old databases upgrade
// without losing data, migrate() stays re-entrant, and cursor read/write goes
// through Drizzle only.

describe("market_sync_state cursor table", () => {
  test("new databases get the table and round-trip cursor rows via Drizzle", () => {
    const db = openDb(":memory:");
    try {
      expect(db.select().from(marketSyncState).all()).toEqual([]);
      db.insert(marketSyncState).values({
        tableName: "market_batches", cursorJson: JSON.stringify(["2026-09-16T08:00:00.000Z", "batch-1"]),
        targetFingerprint: "f".repeat(64), rowsSynced: 42, lastSyncedAt: "2026-09-16T09:00:00.000Z",
      }).run();
      const row = db.select().from(marketSyncState).where(eq(marketSyncState.tableName, "market_batches")).get();
      expect(row?.rowsSynced).toBe(42);
      expect(JSON.parse(row!.cursorJson!)).toEqual(["2026-09-16T08:00:00.000Z", "batch-1"]);
      db.update(marketSyncState).set({ rowsSynced: 84 }).where(eq(marketSyncState.tableName, "market_batches")).run();
      expect(db.select().from(marketSyncState).get()?.rowsSynced).toBe(84);
    } finally { db.$client.close(); }
  });

  test("an old database without the table upgrades in place and keeps its data", () => {
    const dir = mkdtempSync(join(tmpdir(), "radar-sync-state-"));
    const dbPath = join(dir, "radar.db");
    try {
      // Simulate a pre-sync database: only an old market table exists.
      const legacy = new Database(dbPath);
      legacy.exec("CREATE TABLE market_sources (ref TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (ref, revision));");
      legacy.exec("INSERT INTO market_sources VALUES ('hongguo', 1, '{\"source_ref\":\"hongguo\"}')");
      legacy.close();
      const db = openDb(dbPath);
      try {
        const rows = db.$client.query("SELECT ref, revision FROM market_sources").all() as Array<{ ref: string; revision: number }>;
        expect(rows).toEqual([{ ref: "hongguo", revision: 1 }]);
        expect(db.select().from(marketSyncState).all()).toEqual([]);
      } finally { db.$client.close(); }
      // Re-opening runs migrate() again: re-entrant, table and data survive.
      const again = openDb(dbPath);
      try {
        expect(again.$client.query("SELECT ref FROM market_sources").all()).toHaveLength(1);
        expect(again.$client.query("SELECT name FROM sqlite_master WHERE name = 'market_sync_state'").all()).toHaveLength(1);
      } finally { again.$client.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
