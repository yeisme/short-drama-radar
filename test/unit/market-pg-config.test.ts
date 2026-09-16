import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, loadConfig } from "../../src/config.ts";
import {
  REDACTED_DSN, pgConnectionDiagnostics, resolvePgConnection, targetFingerprint,
} from "../../src/market/sync-config.ts";
import { MarketStoreError } from "../../src/market/repository.ts";

// Task 1.3: connection source priority (env over user config), malformed DSN
// refusal, target fingerprinting, 0600 permission warning, and a redaction
// guarantee — a DSN with a password walks every output path and never leaks.

const SECRET_DSN = "postgres://radar:s3cr3t-pw@db.internal:5544/radar_archive_db";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function homeWithConfig(config: unknown, mode = 0o600): string {
  const dir = mkdtempSync(join(tmpdir(), "radar-pg-config-"));
  dirs.push(dir);
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(config));
  chmodSync(path, mode);
  return path;
}

describe("pg connection resolution", () => {
  test("env wins over config; config used when env is absent", () => {
    const configPath = homeWithConfig({ pgArchive: { url: "postgres://u:p@config-host:5433/cfgdb" } });
    process.env.RADAR_CONFIG_PATH = configPath;
    try {
      const cfg = loadConfig();
      const fromEnv = resolvePgConnection(cfg, { RADAR_PG_URL: SECRET_DSN });
      expect(fromEnv.source).toBe("env");
      expect(fromEnv.target).toEqual({ host: "db.internal", port: 5544, db: "radar_archive_db", schema: "radar_archive" });
      const fromConfig = resolvePgConnection(cfg, {});
      expect(fromConfig.source).toBe("config");
      expect(fromConfig.target.host).toBe("config-host");
      expect(fromConfig.target.port).toBe(5433);
      expect(fromConfig.target.db).toBe("cfgdb");
    } finally {
      delete process.env.RADAR_CONFIG_PATH;
    }
  });

  test("missing connection reports pg_config_missing with both recovery locations", () => {
    expect(() => resolvePgConnection({ ...defaultConfig }, {})).toThrowError(MarketStoreError);
    try {
      resolvePgConnection({ ...defaultConfig }, {});
    } catch (err) {
      const error = err as MarketStoreError;
      expect(error.code).toBe("pg_config_missing");
      expect(error.message).toContain("RADAR_PG_URL");
      expect(error.message).toContain("pgArchive.url");
    }
  });

  test("malformed DSNs are rejected with a named code and zero credential echo", () => {
    const bad = ["not-a-url", "http://host/db", "postgres:///db", "postgres://host", "postgres://host:99999/db"];
    for (const dsn of bad) {
      try {
        resolvePgConnection({ ...defaultConfig }, { RADAR_PG_URL: dsn });
        throw new Error("expected pg_config_missing for " + dsn);
      } catch (err) {
        expect((err as MarketStoreError).code).toBe("pg_config_missing");
        expect((err as MarketStoreError).message).not.toContain(dsn);
      }
    }
  });

  test("postgresql:// scheme and default port are accepted", () => {
    const connection = resolvePgConnection({ ...defaultConfig }, { RADAR_PG_URL: "postgresql://u:p@example.com/mydb" });
    expect(connection.target.port).toBe(5432);
    expect(connection.target.db).toBe("mydb");
  });

  test("fingerprint covers host, port, db and schema — never credentials", () => {
    const a = targetFingerprint({ host: "h", port: 5432, db: "d", schema: "radar_archive" });
    const sameTargetDifferentPassword = resolvePgConnection({ ...defaultConfig }, { RADAR_PG_URL: "postgres://x:other@h:5432/d" }).fingerprint;
    expect(sameTargetDifferentPassword).toBe(a);
    const different = targetFingerprint({ host: "h", port: 5433, db: "d", schema: "radar_archive" });
    expect(different).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test("config file holding a DSN warns when not owner-only, without blocking", () => {
    const loose = homeWithConfig({ pgArchive: { url: "postgres://u:p@h/db" } }, 0o644);
    process.env.RADAR_CONFIG_PATH = loose;
    try {
      const connection = resolvePgConnection(loadConfig(), {});
      expect(connection.warnings).toHaveLength(1);
      expect(connection.warnings[0]).toContain("owner-only");
      expect(connection.warnings[0]).toContain("644");
      expect(connection.warnings[0]).not.toContain("postgres://");
    } finally {
      delete process.env.RADAR_CONFIG_PATH;
    }
    const tight = homeWithConfig({ pgArchive: { url: "postgres://u:p@h/db" } }, 0o600);
    process.env.RADAR_CONFIG_PATH = tight;
    try {
      expect(resolvePgConnection(loadConfig(), {}).warnings).toEqual([]);
    } finally {
      delete process.env.RADAR_CONFIG_PATH;
    }
  });

  test("config pgArchive type validation rejects wrong shapes", () => {
    process.env.RADAR_CONFIG_PATH = homeWithConfig({ pgArchive: { url: 42 } });
    try {
      expect(() => loadConfig()).toThrowError(/pgArchive\.url must be a string/);
    } finally {
      delete process.env.RADAR_CONFIG_PATH;
    }
    process.env.RADAR_CONFIG_PATH = homeWithConfig({ pgArchive: "nope" });
    try {
      expect(() => loadConfig()).toThrowError(/pgArchive must be an object/);
    } finally {
      delete process.env.RADAR_CONFIG_PATH;
    }
  });

  test("a password-bearing DSN walks every diagnostic path with zero leakage", () => {
    const connection = resolvePgConnection({ ...defaultConfig }, { RADAR_PG_URL: SECRET_DSN });
    const diagnostics = pgConnectionDiagnostics(connection);
    expect(diagnostics.pg_source).toBe("env");
    expect(diagnostics.pg_target).toBe("db.internal:5544/radar_archive_db schema=radar_archive");
    expect(diagnostics.pg_dsn).toBe(REDACTED_DSN);
    expect(String(diagnostics.pg_target_fingerprint)).toMatch(/^[0-9a-f]{12}$/);
    const rendered = JSON.stringify(diagnostics) + Object.values(diagnostics).join(" ");
    expect(rendered).not.toContain("s3cr3t-pw");
    expect(rendered).not.toContain("postgres://");
    expect(rendered).not.toContain(SECRET_DSN);
  });
});
