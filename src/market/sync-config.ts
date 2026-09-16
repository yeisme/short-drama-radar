import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import { RADAR_HOME, type RadarConfig } from "../config.ts";
import { MarketStoreError } from "./repository.ts";
import { PG_ARCHIVE_SCHEMA } from "../db/pg-schema.ts";

// PG archive connection resolution and redaction (design §5). The DSN comes
// from RADAR_PG_URL first, then the user-level config's pgArchive.url; it is
// never logged, persisted outside the user config, or echoed in errors.

export type PgConnectionSource = "env" | "config";

export interface PgTargetSummary {
  host: string;
  port: number;
  db: string;
  schema: string;
}

export interface PgConnection {
  source: PgConnectionSource;
  dsn: string;
  target: PgTargetSummary;
  fingerprint: string;
  warnings: string[];
}

// Every rendered form of the DSN in output, events and evidence is this
// literal placeholder.
export const REDACTED_DSN = "<redacted>";

function parseDsn(dsn: string): PgTargetSummary {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    throw new MarketStoreError("pg_config_missing", "The configured PostgreSQL connection string is not a valid URL; fix RADAR_PG_URL or pgArchive.url in the user config.");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new MarketStoreError("pg_config_missing", "The PostgreSQL connection string must use the postgres:// or postgresql:// scheme.");
  }
  const db = url.pathname.replace(/^\//, "");
  if (!url.hostname || !db || db.includes("/")) {
    throw new MarketStoreError("pg_config_missing", "The PostgreSQL connection string must include a host and a database name.");
  }
  const port = url.port ? Number(url.port) : 5432;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new MarketStoreError("pg_config_missing", "The PostgreSQL connection string has an invalid port.");
  }
  return { host: url.hostname, port, db, schema: PG_ARCHIVE_SCHEMA };
}

// sha256(host|port|dbname|schema) — no username, password or DSN fragment.
export function targetFingerprint(target: PgTargetSummary): string {
  return createHash("sha256").update(`${target.host}|${target.port}|${target.db}|${target.schema}`).digest("hex");
}

function userConfigPath(): string {
  return process.env.RADAR_CONFIG_PATH ?? join(RADAR_HOME, "config.json");
}

// A config file holding a DSN should be owner-only; warn (never block) when it
// is not, matching local single-user CLI convention.
function configPermissionWarnings(): string[] {
  try {
    const mode = statSync(userConfigPath()).mode & 0o777;
    if (mode !== 0o600) {
      return [`The user config file holding pgArchive.url is not owner-only (mode ${mode.toString(8)}); consider chmod 600 ${userConfigPath()}.`];
    }
  } catch {
    // Unreadable/missing config is handled by loadConfig; nothing to add here.
  }
  return [];
}

export function resolvePgConnection(cfg: RadarConfig, env: NodeJS.ProcessEnv = process.env): PgConnection {
  const fromEnv = env.RADAR_PG_URL;
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    const target = parseDsn(fromEnv);
    return { source: "env", dsn: fromEnv, target, fingerprint: targetFingerprint(target), warnings: [] };
  }
  const fromConfig = cfg.pgArchive?.url;
  if (fromConfig !== undefined && fromConfig.trim() !== "") {
    const target = parseDsn(fromConfig);
    return { source: "config", dsn: fromConfig, target, fingerprint: targetFingerprint(target), warnings: configPermissionWarnings() };
  }
  throw new MarketStoreError("pg_config_missing",
    "No PostgreSQL connection configured. Set the RADAR_PG_URL environment variable or add pgArchive.url to the user config (" + userConfigPath() + ").");
}

// Credential-free diagnostics for sync facts, doctor and events: source type,
// redacted host/db/schema and the fingerprint prefix only.
export function pgConnectionDiagnostics(connection: PgConnection): Record<string, unknown> {
  return {
    pg_source: connection.source,
    pg_target: `${connection.target.host}:${connection.target.port}/${connection.target.db} schema=${connection.target.schema}`,
    pg_target_fingerprint: connection.fingerprint.slice(0, 12),
    pg_dsn: REDACTED_DSN,
  };
}
