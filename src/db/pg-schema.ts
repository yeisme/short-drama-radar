import { integer, pgSchema, primaryKey, text, timestamp, type PgTable } from "drizzle-orm/pg-core";
import { MARKET_SYNC_TABLES, type SyncTableDef } from "../market/sync-tables.ts";

// PG mirror of the allowlisted market tables (design §2): the same columns as
// the SQLite source plus exactly two archive columns — payload_digest for
// conflict verification and synced_at as the archive timestamp. Table and DDL
// generation are both driven by MARKET_SYNC_TABLES so the two dialects can
// never drift into two hand-copied definitions.

export const PG_ARCHIVE_SCHEMA = "radar_archive";

const archive = pgSchema(PG_ARCHIVE_SCHEMA);

function mirrorTable(def: SyncTableDef): PgTable {
  const columns: Record<string, ReturnType<typeof text> | ReturnType<typeof integer>> = {};
  for (const column of def.columns) {
    const builder = column.kind === "integer" ? integer(column.name) : text(column.name);
    columns[column.name] = column.nullable ? builder : builder.notNull();
  }
  return archive.table(def.name, {
    ...columns,
    payload_digest: text("payload_digest").notNull(),
    synced_at: timestamp("synced_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  } as never, ((table: Record<string, unknown>) => [
    // Columns exist by construction from def.idempotencyKey; drizzle's
    // builder-vs-column generics cannot see through the dynamic mapping.
    (primaryKey as (config: { columns: unknown[] }) => unknown)({ columns: def.idempotencyKey.map(key => table[key]) }),
  ]) as never) as PgTable;
}

export const pgArchiveTables: Record<string, PgTable> = Object.fromEntries(
  MARKET_SYNC_TABLES.map(def => [def.name, mirrorTable(def)]),
);

// Re-entrant DDL generated from the same definitions (executed only by
// migratePg() in pg-client.ts, same convention as the sqlite migrate()).
export const PG_ARCHIVE_DDL: string[] = MARKET_SYNC_TABLES.map(def => {
  const columnSql = def.columns.map(column => {
    const type = column.kind === "integer" ? "INTEGER" : "TEXT";
    return `${column.name} ${type}${column.nullable ? "" : " NOT NULL"}`;
  });
  columnSql.push("payload_digest TEXT NOT NULL");
  columnSql.push("synced_at TIMESTAMPTZ NOT NULL DEFAULT now()");
  columnSql.push(`PRIMARY KEY (${def.idempotencyKey.join(", ")})`);
  return `CREATE TABLE IF NOT EXISTS ${PG_ARCHIVE_SCHEMA}.${def.name} (\n  ${columnSql.join(",\n  ")}\n)`;
});
