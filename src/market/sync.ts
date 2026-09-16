import { and, asc, eq, or, type Column, type SQL } from "drizzle-orm";
import { getTableColumns } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { RadarDb } from "../db/client.ts";
import type { RadarPgDb } from "../db/pg-client.ts";
import { classifyPgError } from "../db/pg-client.ts";
import { pgArchiveTables } from "../db/pg-schema.ts";
import { marketSyncState } from "../db/schema.ts";
import type { EventWriter } from "../output/events.ts";
import { MarketStoreError, marketDigest } from "./repository.ts";
import { MARKET_SYNC_TABLES, type SyncTableDef } from "./sync-tables.ts";
import {
  cursorOfRow, normalizeChunkSize, parseCursor, readChunk, serializeCursor,
  type CursorValue, type SyncRow,
} from "./sync-plan.ts";

// PG archive sync engine (design §4): idempotent append-only writes with
// digest-checked conflicts, cursors that advance only after the PG
// transaction commits, a target-fingerprint gate and a zero-write --verify.
// PG access sits behind the narrow PgArchive interface so the engine logic
// (conflict classification, transaction boundaries) is unit-testable; the
// real postgres.js implementation lives in postgresArchive() below.

export interface ArchivedRow {
  values: SyncRow;
  digest: string;
}

export interface PgArchive {
  /** INSERT ... ON CONFLICT (pk) DO NOTHING in one transaction; returns the idempotency keys that already existed. */
  insertIgnore(def: SyncTableDef, rows: ArchivedRow[]): Promise<CursorValue[][]>;
  /** Stored payload_digest per idempotency key (null when absent). */
  digestsOf(def: SyncTableDef, keys: CursorValue[][]): Promise<(string | null)[]>;
  rowCount(def: SyncTableDef): Promise<number>;
  /** First `limit` rows ordered by idempotency key with their digests. */
  sample(def: SyncTableDef, limit: number): Promise<Array<{ key: CursorValue[]; digest: string }>>;
}

export const VERIFY_SAMPLE_LIMIT = 100;

// The digest input is the payload object itself for payload tables, or the
// set of business columns for receipt tables (design §2). JSON columns are
// parsed back to objects so marketDigest sees the same value on both sides.
export function rowDigest(def: SyncTableDef, row: SyncRow): string {
  const input: Record<string, unknown> = {};
  for (const name of def.digestColumns) {
    const column = def.columns.find(c => c.name === name)!;
    const value = row[name];
    input[name] = column.kind === "json" && typeof value === "string" ? JSON.parse(value) : value;
  }
  return marketDigest(def.digestColumns.length === 1 ? input[def.digestColumns[0]!] : input);
}

const digestPrefix = (digest: string) => digest.slice(0, 19); // "sha256:" + 12 hex chars
const keyLabel = (key: CursorValue[]) => JSON.stringify(key);

// Conflict and verification identity is the idempotency key (= primary key);
// the cursor order is only for chunked reading.
export function keyOfRow(row: SyncRow, def: SyncTableDef): CursorValue[] {
  return def.idempotencyKey.map(name => row[name] as CursorValue);
}

export interface SyncOptions {
  chunkSize?: string;
  resetCursor?: boolean;
  confirmReset?: boolean;
  allowTargetChange?: boolean;
}

export interface TableSyncReport {
  table: string;
  rows_synced: number;
  rows_reused: number;
  chunks: number;
}

export interface SyncReport {
  tables: TableSyncReport[];
  rows_synced: number;
  rows_reused: number;
  chunks: number;
  resumed: boolean;
}

interface SyncStateRow {
  tableName: string;
  cursorJson: string | null;
  targetFingerprint: string;
  rowsSynced: number;
  lastSyncedAt: string;
}

function stateOf(db: RadarDb, table: string): SyncStateRow | undefined {
  return db.select().from(marketSyncState).where(eq(marketSyncState.tableName, table)).get() as SyncStateRow | undefined;
}

function writeState(db: RadarDb, row: SyncStateRow): void {
  db.insert(marketSyncState).values(row)
    .onConflictDoUpdate({
      target: marketSyncState.tableName,
      set: { cursorJson: row.cursorJson, targetFingerprint: row.targetFingerprint, rowsSynced: row.rowsSynced, lastSyncedAt: row.lastSyncedAt },
    })
    .run();
}

// The fingerprint gate (design §4): a stored fingerprint from a different
// target refuses to resume without --allow-target-change; confirming switches
// the cursor line to the new target with a fresh full replay.
function gateTarget(db: RadarDb, fingerprint: string, allowTargetChange: boolean): void {
  const states = db.select().from(marketSyncState).all() as SyncStateRow[];
  const foreign = states.filter(s => s.targetFingerprint !== fingerprint);
  if (foreign.length === 0) return;
  if (!allowTargetChange) {
    throw new MarketStoreError("sync_target_changed",
      `The stored sync cursors belong to a different PostgreSQL target (${foreign[0]!.targetFingerprint.slice(0, 12)}…); re-run with --allow-target-change to confirm the switch and start a fresh full replay.`);
  }
  for (const state of foreign) {
    writeState(db, { ...state, cursorJson: null, rowsSynced: 0, targetFingerprint: fingerprint, lastSyncedAt: new Date().toISOString() });
  }
}

function resetCursors(db: RadarDb, fingerprint: string): void {
  const states = db.select().from(marketSyncState).all() as SyncStateRow[];
  for (const state of states) {
    writeState(db, { ...state, cursorJson: null, rowsSynced: 0, targetFingerprint: fingerprint, lastSyncedAt: new Date().toISOString() });
  }
}

export async function syncMarketToPg(db: RadarDb, pg: PgArchive, fingerprint: string, opts: SyncOptions, events?: EventWriter): Promise<SyncReport> {
  const chunkSize = normalizeChunkSize(opts.chunkSize);
  if (opts.resetCursor) {
    if (!opts.confirmReset) {
      throw new MarketStoreError("flag_invalid", "--reset-cursor requires --confirm-reset; the full replay is idempotent but must be confirmed explicitly.");
    }
    resetCursors(db, fingerprint);
  }
  gateTarget(db, fingerprint, opts.allowTargetChange === true);
  const resumed = (db.select().from(marketSyncState).all() as SyncStateRow[]).some(s => s.cursorJson !== null || s.rowsSynced > 0);
  const report: SyncReport = { tables: [], rows_synced: 0, rows_reused: 0, chunks: 0, resumed };
  for (const def of MARKET_SYNC_TABLES) {
    const tableReport = await syncTable(db, pg, def, fingerprint, chunkSize);
    report.tables.push(tableReport);
    report.rows_synced += tableReport.rows_synced;
    report.rows_reused += tableReport.rows_reused;
    report.chunks += tableReport.chunks;
    events?.emit({
      event: "phase", phase: "table_synced", table: def.name,
      rows_synced: tableReport.rows_synced, rows_reused: tableReport.rows_reused, chunks: tableReport.chunks,
    });
  }
  return report;
}

async function syncTable(db: RadarDb, pg: PgArchive, def: SyncTableDef, fingerprint: string, chunkSize: number): Promise<TableSyncReport> {
  const state = stateOf(db, def.name);
  let cursor = parseCursor(state?.cursorJson ?? null, def);
  const table: TableSyncReport = { table: def.name, rows_synced: 0, rows_reused: 0, chunks: 0 };
  for (;;) {
    const chunk = readChunk(db, def, cursor, chunkSize);
    if (chunk.rows.length === 0) break;
    const rows: ArchivedRow[] = chunk.rows.map(values => ({ values, digest: rowDigest(def, values) }));
    const conflictKeys = await pg.insertIgnore(def, rows);
    let reusedInChunk = 0;
    if (conflictKeys.length > 0) {
      const stored = await pg.digestsOf(def, conflictKeys);
      const byKey = new Map(rows.map(r => [keyLabel(keyOfRow(r.values, def)), r.digest]));
      conflictKeys.forEach((key, index) => {
        const local = byKey.get(keyLabel(key));
        const remote = stored[index];
        if (local !== undefined && remote !== null && local !== remote) {
          // Never overwrite: the table aborts, the cursor stays before this
          // chunk, and other tables keep their own committed state.
          throw new MarketStoreError("sync_conflict",
            `${def.name}: key ${keyLabel(key)} has digest ${digestPrefix(local)} locally but ${digestPrefix(remote)} in the archive; the table was aborted with zero rewrites. Owner review is required — existing archive rows are never updated or deleted.`);
        }
        reusedInChunk++;
      });
    }
    const syncedInChunk = chunk.rows.length - reusedInChunk;
    table.rows_reused += reusedInChunk;
    table.rows_synced += syncedInChunk;
    table.chunks++;
    // The PG transaction committed: only now the cursor advances.
    cursor = chunk.nextCursor;
    const previous = stateOf(db, def.name);
    writeState(db, {
      tableName: def.name,
      cursorJson: cursor ? serializeCursor(cursor) : null,
      targetFingerprint: fingerprint,
      rowsSynced: (previous?.rowsSynced ?? 0) + syncedInChunk,
      lastSyncedAt: new Date().toISOString(),
    });
    if (!chunk.nextCursor) break;
  }
  return table;
}

export interface VerifyDifference {
  table: string;
  kind: "row_count" | "digest_mismatch" | "missing_in_archive";
  detail: string;
}

export interface VerifyReport {
  ok: boolean;
  differences: VerifyDifference[];
  tables_checked: number;
}

// Zero-write reconciliation (design §4): per-table row counts plus an ordered
// digest sample of at most VERIFY_SAMPLE_LIMIT rows per table.
export async function verifyMarketPg(db: RadarDb, pg: PgArchive, fingerprint: string, opts: { allowTargetChange?: boolean } = {}): Promise<VerifyReport> {
  gateTarget(db, fingerprint, opts.allowTargetChange === true);
  const differences: VerifyDifference[] = [];
  for (const def of MARKET_SYNC_TABLES) {
    const localRows = readAllOrdered(db, def);
    const remoteCount = await pg.rowCount(def);
    if (remoteCount !== localRows.length) {
      differences.push({
        table: def.name, kind: "row_count",
        detail: `${def.name}: ${localRows.length} local row(s) vs ${remoteCount} archived row(s)`,
      });
    }
    const sampleRows = localRows.slice(0, VERIFY_SAMPLE_LIMIT);
    const remoteSample = new Map((await pg.sample(def, VERIFY_SAMPLE_LIMIT)).map(r => [keyLabel(r.key), r.digest]));
    for (const row of sampleRows) {
      const key = keyOfRow(row, def);
      const remote = remoteSample.get(keyLabel(key));
      if (remote === undefined) {
        differences.push({ table: def.name, kind: "missing_in_archive", detail: `${def.name}: key ${keyLabel(key)} has no archived row` });
      } else {
        const local = rowDigest(def, row);
        if (local !== remote) {
          differences.push({
            table: def.name, kind: "digest_mismatch",
            detail: `${def.name}: key ${keyLabel(key)} digest ${digestPrefix(local)} locally vs ${digestPrefix(remote)} archived`,
          });
        }
      }
    }
  }
  return { ok: differences.length === 0, differences, tables_checked: MARKET_SYNC_TABLES.length };
}

// Full ordered walk for verify; chunked through the same keyset logic.
function readAllOrdered(db: RadarDb, def: SyncTableDef): SyncRow[] {
  const rows: SyncRow[] = [];
  let cursor: CursorValue[] | null = null;
  for (;;) {
    const chunk = readChunk(db, def, cursor, 1000);
    rows.push(...chunk.rows);
    if (!chunk.nextCursor) return rows;
    cursor = chunk.nextCursor;
  }
}

// --- postgres.js backed implementation ---------------------------------------

type PgColumnAccess = Record<string, Column>;

function pgColumns(table: PgTable): PgColumnAccess {
  // The mirror uses DB column names as property keys, so access is direct.
  return getTableColumns(table) as unknown as PgColumnAccess;
}

function pkCondition(columns: PgColumnAccess, def: SyncTableDef, key: CursorValue[]): SQL {
  return and(...def.idempotencyKey.map((name, i) => eq(columns[name]!, key[i]!)))!;
}

export function postgresArchive(pg: RadarPgDb): PgArchive {
  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (err) {
      if (err instanceof MarketStoreError) throw err;
      throw classifyPgError(err);
    }
  };
  return {
    async insertIgnore(def, rows) {
      return run(async () => {
        const table = pgArchiveTables[def.name]!;
        const columns = pgColumns(table);
        const inserted = await pg.transaction(tx =>
          tx.insert(table as never)
            .values(rows.map(r => ({ ...r.values, payload_digest: r.digest })) as never)
            .onConflictDoNothing({ target: def.idempotencyKey.map(name => columns[name]!) as never })
            .returning() as never);
        const insertedKeys = new Set((inserted as Array<Record<string, unknown>>).map(row => keyLabel(def.idempotencyKey.map(name => row[name] as CursorValue))));
        return rows.map(r => keyOfRow(r.values, def)).filter(key => !insertedKeys.has(keyLabel(key)));
      });
    },
    async digestsOf(def, keys) {
      return run(async () => {
        if (keys.length === 0) return [];
        const table = pgArchiveTables[def.name]!;
        const columns = pgColumns(table);
        const rows = await pg
          .select()
          .from(table as never)
          .where(or(...keys.map(key => pkCondition(columns, def, key)))) as Array<Record<string, unknown>>;
        const byKey = new Map(rows.map(row => [keyLabel(def.idempotencyKey.map(name => row[name] as CursorValue)), row["payload_digest"] as string]));
        return keys.map(key => byKey.get(keyLabel(key)) ?? null);
      });
    },
    async rowCount(def) {
      return run(() => pg.$count(pgArchiveTables[def.name]! as never));
    },
    async sample(def, limit) {
      return run(async () => {
        const table = pgArchiveTables[def.name]!;
        const columns = pgColumns(table);
        const rows = await pg
          .select()
          .from(table as never)
          .orderBy(...def.idempotencyKey.map(name => asc(columns[name]!)))
          .limit(limit) as Array<Record<string, unknown>>;
        return rows.map(row => ({
          key: def.idempotencyKey.map(name => row[name] as CursorValue),
          digest: row["payload_digest"] as string,
        }));
      });
    },
  };
}

// Inert archive used by --verify dry checks and unit tests; every method
// fails loudly so a missing real target can never fake a pass.
export function unsupportedTargetError(target: string): MarketStoreError {
  return new MarketStoreError("sync_target_unsupported", `Unsupported sync target '${target}'; supported targets: pg.`);
}
