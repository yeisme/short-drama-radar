import { describe, expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import { getTableConfig as getSqliteTableConfig } from "drizzle-orm/sqlite-core";
import { PG_ARCHIVE_DDL, PG_ARCHIVE_SCHEMA, pgArchiveTables } from "../../src/db/pg-schema.ts";
import {
  MARKET_SYNC_EXCLUDED_TABLES, MARKET_SYNC_TABLES, sqliteTableFor, syncTableDef,
} from "../../src/market/sync-tables.ts";
import * as sqliteSchema from "../../src/db/schema.ts";

// Task 1.2: the PG mirror schema and the sync allowlist share one source of
// truth. Every allowlisted table exists in radar_archive with the SQLite
// primary key as its idempotency key; personal/local state stays out.

describe("market pg mirror schema", () => {
  test("the allowlist covers exactly the 12 market evidence tables", () => {
    expect(MARKET_SYNC_TABLES.map(t => t.name)).toEqual([
      "market_sources", "market_batches", "market_observations", "market_evidence",
      "market_signals", "market_work_mappings", "market_briefs", "market_reviews",
      "market_sampling_plans", "market_sampling_checks",
      "market_qualification_records", "market_source_reviews",
    ]);
  });

  test("every allowlisted table has a pg mirror with matching columns and idempotency key", () => {
    for (const def of MARKET_SYNC_TABLES) {
      const pgTable = pgArchiveTables[def.name];
      expect(pgTable, def.name).toBeDefined();
      const pgConfig = getTableConfig(pgTable!);
      expect(pgConfig.schema).toBe(PG_ARCHIVE_SCHEMA);
      const pgColumns = pgConfig.columns.map(c => c.name);
      // Mirror columns = sqlite columns + the two archive columns, nothing else.
      expect(pgColumns).toEqual([...def.columns.map(c => c.name), "payload_digest", "synced_at"]);
      const sqliteConfig = getSqliteTableConfig(sqliteTableFor(def));
      const sqliteColumns = sqliteConfig.columns.map(c => c.name);
      expect(def.columns.map(c => c.name)).toEqual(sqliteColumns);
      // Idempotency key equals the SQLite primary key (inline .primaryKey()
      // marks the column; composite keys live in config.primaryKeys).
      const pkOf = (config: { columns: Array<{ name: string; primary: boolean }>; primaryKeys: Array<{ columns: Array<{ name: string }> }> }) =>
        config.primaryKeys[0]?.columns.map(c => c.name) ?? config.columns.filter(c => c.primary).map(c => c.name);
      expect(def.idempotencyKey).toEqual(pkOf(sqliteConfig as never));
      expect(pkOf(pgConfig as never)).toEqual(def.idempotencyKey);
      // Cursor order is deterministic and ends in the idempotency key.
      expect(def.cursorOrder.slice(-def.idempotencyKey.length)).toEqual(def.idempotencyKey);
      // Digest input covers real business content.
      expect(def.digestColumns.length).toBeGreaterThan(0);
      expect(def.digestColumns.every(c => sqliteColumns.includes(c))).toBe(true);
    }
  });

  test("generated DDL is re-entrant and carries both archive columns", () => {
    expect(PG_ARCHIVE_DDL).toHaveLength(MARKET_SYNC_TABLES.length);
    for (const [index, def] of MARKET_SYNC_TABLES.entries()) {
      const ddl = PG_ARCHIVE_DDL[index]!;
      expect(ddl).toContain(`CREATE TABLE IF NOT EXISTS ${PG_ARCHIVE_SCHEMA}.${def.name}`);
      expect(ddl).toContain("payload_digest TEXT NOT NULL");
      expect(ddl).toContain("synced_at TIMESTAMPTZ NOT NULL DEFAULT now()");
      expect(ddl).toContain(`PRIMARY KEY (${def.idempotencyKey.join(", ")})`);
      expect(ddl).not.toMatch(/cookie|password|token/i);
    }
  });

  test("personal and local state tables are explicitly excluded from the allowlist", () => {
    const allowlist = new Set(MARKET_SYNC_TABLES.map(t => t.name));
    const sqliteTableNames = Object.values(sqliteSchema)
      .map(value => {
        try { return getSqliteTableConfig(value as never).name; } catch { return null; }
      })
      .filter((name): name is string => typeof name === "string");
    for (const name of sqliteTableNames) {
      if (!allowlist.has(name)) {
        expect(MARKET_SYNC_EXCLUDED_TABLES as readonly string[], `${name} must be either allowlisted or explicitly excluded`).toContain(name);
      }
    }
    for (const excluded of MARKET_SYNC_EXCLUDED_TABLES) {
      expect(allowlist.has(excluded)).toBe(false);
    }
    expect(MARKET_SYNC_EXCLUDED_TABLES).toContain("personal_profiles");
    expect(MARKET_SYNC_EXCLUDED_TABLES).toContain("market_readers");
    expect(MARKET_SYNC_EXCLUDED_TABLES).toContain("market_watches");
  });

  test("syncTableDef rejects unknown tables instead of guessing", () => {
    expect(syncTableDef("market_batches").idempotencyKey).toEqual(["ref"]);
    expect(() => syncTableDef("personal_profiles")).toThrow("unknown sync table");
  });
});
