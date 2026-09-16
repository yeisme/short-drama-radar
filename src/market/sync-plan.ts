import { and, asc, eq, gt, or, type SQL } from "drizzle-orm";
import { getTableColumns, type Column } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { RadarDb } from "../db/client.ts";
import { MarketStoreError } from "./repository.ts";
import { sqliteTableFor, type SyncTableDef } from "./sync-tables.ts";

// Chunked keyset reads for the PG archive sync (design §4). Pure planning and
// cursor logic: chunk boundaries are deterministic, replaying a chunk is
// idempotent, and a corrupt cursor fails closed with cursor_invalid.

export const DEFAULT_CHUNK_SIZE = 500;
export const MAX_CHUNK_SIZE = 5000;

export type CursorValue = string | number;
export type SyncRow = Record<string, string | number | null>;

export function normalizeChunkSize(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_CHUNK_SIZE;
  const size = Number(raw);
  if (!Number.isInteger(size) || size < 1 || size > MAX_CHUNK_SIZE) {
    throw new MarketStoreError("flag_invalid", `--chunk-size must be an integer between 1 and ${MAX_CHUNK_SIZE}, got '${raw}'.`);
  }
  return size;
}

// DB column name <-> drizzle column object, resolved from the table itself so
// the mapping can never drift from schema.ts.
function columnMap(table: SQLiteTable): Map<string, SQLiteColumn> {
  const map = new Map<string, SQLiteColumn>();
  for (const column of Object.values(getTableColumns(table)) as Column[]) {
    map.set(column.name, column as SQLiteColumn);
  }
  return map;
}

export function serializeCursor(values: CursorValue[]): string {
  return JSON.stringify(values);
}

// A stored cursor must be a JSON array matching the table's cursor order in
// arity and primitive types; anything else refuses to resume.
export function parseCursor(json: string | null, def: SyncTableDef): CursorValue[] | null {
  if (json === null) return null;
  const invalid = () => new MarketStoreError("cursor_invalid",
    `The stored sync cursor for ${def.name} is corrupt or out of range; re-run 'radar market sync --to pg --reset-cursor --confirm-reset' for a full replay (idempotent).`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw invalid();
  }
  if (!Array.isArray(parsed) || parsed.length !== def.cursorOrder.length) throw invalid();
  return parsed.map((value, index) => {
    const column = def.columns.find(c => c.name === def.cursorOrder[index]);
    const expected = column?.kind === "integer" ? "number" : "string";
    if (typeof value !== expected || (expected === "number" && !Number.isSafeInteger(value as number))) throw invalid();
    return value as CursorValue;
  });
}

export function cursorOfRow(row: SyncRow, def: SyncTableDef): CursorValue[] {
  return def.cursorOrder.map(name => {
    const value = row[name];
    if (value === null || value === undefined) {
      throw new MarketStoreError("cursor_invalid", `Row in ${def.name} is missing cursor column ${name}; cannot checkpoint.`);
    }
    return value;
  });
}

export interface SyncChunk {
  rows: SyncRow[];
  /** Cursor of the last row when the chunk is full; null when the table is done. */
  nextCursor: CursorValue[] | null;
}

// Keyset pagination: (c1, c2, ...) > (v1, v2, ...) built from drizzle
// operators — no string-concatenated SQL.
function keysetCondition(columns: SQLiteColumn[], values: CursorValue[]): SQL {
  const parts: SQL[] = [];
  for (let i = 0; i < columns.length; i++) {
    const prefix = columns.slice(0, i).map((column, j) => eq(column, values[j]!));
    parts.push(and(...prefix, gt(columns[i]!, values[i]!))!);
  }
  return parts.length === 1 ? parts[0]! : or(...parts)!;
}

export function readChunk(db: RadarDb, def: SyncTableDef, cursor: CursorValue[] | null, chunkSize: number): SyncChunk {
  const table = sqliteTableFor(def);
  const columns = columnMap(table);
  const orderColumns = def.cursorOrder.map(name => {
    const column = columns.get(name);
    if (!column) throw new Error(`sync table ${def.name} is missing cursor column ${name}`);
    return column;
  });
  let query = db.select().from(table).orderBy(...orderColumns.map(c => asc(c))).limit(chunkSize);
  if (cursor) query = query.where(keysetCondition(orderColumns, cursor)) as typeof query;
  const rawRows = query.all() as Array<Record<string, unknown>>;
  // Normalize drizzle's camelCase row objects back to DB column names so the
  // same row shape feeds the digest, the PG insert and the cursor.
  const propertyByDbName = new Map<string, string>();
  for (const [property, column] of Object.entries(getTableColumns(table))) {
    propertyByDbName.set((column as Column).name, property);
  }
  const rows: SyncRow[] = rawRows.map(raw => {
    const row: SyncRow = {};
    for (const column of def.columns) {
      const property = propertyByDbName.get(column.name)!;
      const value = raw[property];
      row[column.name] = value === null || value === undefined ? null
        : column.kind === "json" ? JSON.stringify(value)
        : (value as string | number);
    }
    return row;
  });
  return {
    rows,
    nextCursor: rows.length === chunkSize ? cursorOfRow(rows.at(-1)!, def) : null,
  };
}
