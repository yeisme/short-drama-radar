import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as pgSchema from "./pg-schema.ts";
import { MarketStoreError } from "../market/repository.ts";

// PostgreSQL archive connection layer. The DSN never leaves this module in
// logs or errors: every failure surfaces as a named MarketStoreError with a
// credential-free message. One bounded connection per process; no pool.

export type RadarPgDb = PostgresJsDatabase<typeof pgSchema>;

export interface RadarPg {
  db: RadarPgDb;
  close: () => Promise<void>;
}

// Bounded connection parameters (design §5). All timing knobs live here.
export const PG_CONNECTION_LIMITS = {
  max: 1,
  connect_timeout: 10, // seconds
  idle_timeout: 10, // seconds
  max_lifetime: 0, // process ends when the command ends
} as const;

export const PG_STATEMENT_TIMEOUT_MS = 60_000;

export async function openPg(dsn: string): Promise<RadarPg> {
  const client = postgres(dsn, {
    ...PG_CONNECTION_LIMITS,
    onnotice: () => {},
  });
  try {
    await client`SELECT 1`;
    await client.unsafe(`SET statement_timeout = ${PG_STATEMENT_TIMEOUT_MS}`);
  } catch (err) {
    await client.end({ timeout: 1 }).catch(() => {});
    throw classifyPgError(err);
  }
  return { db: drizzle(client, { schema: pgSchema }), close: () => client.end({ timeout: 5 }) };
}

// Classify driver failures into the stable named codes (design §6). Messages
// must never echo the DSN or any credential fragment.
export function classifyPgError(err: unknown): MarketStoreError {
  const message = err instanceof Error ? err.message : String(err);
  if (/\b(28P01|28000)\b|password authentication failed|no pg_hba\.conf entry|SASL/i.test(message)) {
    return new MarketStoreError("pg_auth_failed", "PostgreSQL rejected the credentials; check the configured connection source.");
  }
  if (/does not exist|undefined_table|undefined_column|invalid schema|42704|42P01|3F000/i.test(message)) {
    return new MarketStoreError("schema_mismatch", "The radar_archive schema does not match the expected layout; the owner must reset or repair it, then re-run the sync.");
  }
  return new MarketStoreError("pg_unavailable", "PostgreSQL is unreachable or timed out; re-run the same command to resume the sync.");
}

// DDL lives here (allowed exception, same convention as the sqlite migrate());
// all business reads/writes go through Drizzle. Every statement is re-entrant.
export async function migratePg(pg: RadarPgDb): Promise<void> {
  const sql = (pg as unknown as { $client: ReturnType<typeof postgres> }).$client;
  const statements = [
    `CREATE SCHEMA IF NOT EXISTS ${pgSchema.PG_ARCHIVE_SCHEMA}`,
    ...pgSchema.PG_ARCHIVE_DDL,
  ];
  for (const statement of statements) {
    try {
      await sql.unsafe(statement);
    } catch (err) {
      throw classifyPgError(err);
    }
  }
}
