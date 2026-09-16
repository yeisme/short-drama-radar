import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import postgres from "postgres";

// Tasks 4.1 + 4.2: real-PostgreSQL verification of the archive sync.
// Target resolution: Testcontainers (PostgreSqlContainer) when Docker is
// available, else the disposable instance at RADAR_TEST_PG_URL, else the
// whole file skips explicitly and prints a pg_integration_skipped marker for
// the evidence summary. A mock never stands in for a real PG pass here.

interface PgTarget {
  dsn: string;
  stop: () => Promise<void>;
}

async function resolvePgTarget(): Promise<PgTarget | null> {
  const docker = process.env.RADAR_TEST_PG_DISPOSABLE === "1"
    ? { status: 1 } : spawnSync("docker", ["info"], { timeout: 8000, stdio: "ignore" });
  if (docker.status === 0) {
    try {
      const { PostgreSqlContainer } = await import("testcontainers") as unknown as {
        PostgreSqlContainer: new (image: string) => {
          start(): Promise<{ getConnectionUri(): string; stop(): Promise<unknown> }>;
        };
      };
      const container = await new PostgreSqlContainer("postgres:16-alpine").start();
      return { dsn: container.getConnectionUri(), stop: () => container.stop().then(() => {}) };
    } catch (err) {
      console.log(JSON.stringify({ testcontainers_unavailable: String((err as Error).message ?? err) }));
    }
  }
  const fallback = process.env.RADAR_TEST_PG_URL;
  if (fallback && fallback.trim() !== "") {
    return {
      dsn: fallback,
      stop: async () => {
        const sql = postgres(fallback, { max: 1, connect_timeout: 10, onnotice: () => {} });
        await sql.unsafe("DROP SCHEMA IF EXISTS radar_archive CASCADE").catch(() => {});
        await sql.end({ timeout: 5 });
      },
    };
  }
  return null;
}

const target = await resolvePgTarget();

if (!target) {
  console.log(JSON.stringify({ pg_integration_skipped: true, reason: "no docker daemon and RADAR_TEST_PG_URL unset" }));
  test.skip("market pg sync integration (pg_integration_skipped: no docker, RADAR_TEST_PG_URL unset)", () => {});
} else {
  const home = mkdtempSync(join(tmpdir(), "radar-pg-it-"));
  const dbPath = join(home, "radar.db");

  const invoke = (...args: string[]) => {
    const proc = Bun.spawnSync([process.execPath, "run", "src/cli.ts", ...args, "--json"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        RADAR_HOME: home,
        RADAR_DB_PATH: dbPath,
        RADAR_CONFIG_PATH: join(home, "config.json"),
        RADAR_PG_URL: target.dsn,
      },
    });
    const stdout = proc.stdout.toString();
    return { exit: proc.exitCode, body: JSON.parse(stdout), stderr: proc.stderr.toString() };
  };

  const admin = () => postgres(target.dsn, { max: 1, connect_timeout: 10, onnotice: () => {} });

  beforeAll(() => {
    // Seed real market evidence through the CLI: sources, a catalog import
    // with observations/evidence and work mapping candidates.
    expect(invoke("market", "init").exit).toBe(0);
    const catalog = invoke("market", "import-catalog", "--source", "dramabox",
      "--file", "test/fixtures/market/dramabox.md", "--format", "markdown",
      "--observed-at", "2026-09-11T08:00:00Z", "--fixture");
    expect(catalog.exit).toBe(0);
    expect(catalog.body.data.items).toBeGreaterThan(0);
  }, 60000);

  afterAll(async () => {
    rmSync(home, { recursive: true, force: true });
    await target.stop();
  });

  const countArchive = async (table: string): Promise<number> => {
    const sql = admin();
    try {
      const rows = await sql.unsafe(`SELECT count(*)::int AS n FROM radar_archive.${table}`);
      return (rows[0] as unknown as { n: number }).n;
    } finally {
      await sql.end({ timeout: 5 });
    }
  };

  test("first sync archives all allowlisted rows; replay adds nothing; verify passes", async () => {
    const first = invoke("market", "sync", "--to", "pg");
    expect(first.exit).toBe(0);
    expect(first.body.command).toBe("radar.market.sync");
    expect(first.body.facts.rows_synced).toBeGreaterThan(0);
    expect(first.body.facts.pg_source).toBe("env");
    expect(first.body.facts.pg_dsn).toBe("<redacted>");
    expect(JSON.stringify(first.body)).not.toContain("postgres://");
    expect(first.body.facts.pg_target_fingerprint).toMatch(/^[0-9a-f]{12}$/);
    const sources = await countArchive("market_sources");
    expect(sources).toBeGreaterThan(0);
    const observations = await countArchive("market_observations");
    expect(observations).toBeGreaterThan(0);

    const replay = invoke("market", "sync", "--to", "pg");
    expect(replay.exit).toBe(0);
    expect(replay.body.facts.rows_synced).toBe(0);
    expect(replay.body.facts.rows_reused).toBe(first.body.facts.rows_synced);
    expect(await countArchive("market_sources")).toBe(sources);
    expect(await countArchive("market_observations")).toBe(observations);

    const verify = invoke("market", "sync", "--to", "pg", "--verify");
    expect(verify.exit).toBe(0);
    expect(verify.body.data.ok).toBe(true);
    expect(verify.body.data.differences).toEqual([]);
  }, 60000);

  test("killing the process mid-sync resumes to the same final state", async () => {
    // Fresh home with the same seed so this scenario is independent.
    const home2 = mkdtempSync(join(tmpdir(), "radar-pg-it-kill-"));
    const dbPath2 = join(home2, "radar.db");
    const env = {
      ...process.env,
      RADAR_HOME: home2, RADAR_DB_PATH: dbPath2,
      RADAR_CONFIG_PATH: join(home2, "config.json"),
      RADAR_PG_URL: target.dsn,
    };
    try {
      const seed = (...args: string[]) =>
        Bun.spawnSync([process.execPath, "run", "src/cli.ts", ...args, "--json"], { cwd: process.cwd(), env });
      expect(seed("market", "init").exitCode).toBe(0);
      expect(seed("market", "import-catalog", "--source", "dramabox",
        "--file", "test/fixtures/market/dramabox.md", "--format", "markdown",
        "--observed-at", "2026-09-11T08:00:00Z", "--fixture").exitCode).toBe(0);
      // Start a slow chunked sync and kill it mid-run; the PG transaction of
      // the in-flight chunk rolls back, the cursor keeps the last commit.
      const proc = Bun.spawn([process.execPath, "run", "src/cli.ts", "market", "sync", "--to", "pg", "--chunk-size", "1", "--json"], { cwd: process.cwd(), env });
      await new Promise(resolve => setTimeout(resolve, 250));
      proc.kill(9);
      await proc.exited;
      // Resume: the same command finishes and verification agrees.
      const resumed = Bun.spawnSync([process.execPath, "run", "src/cli.ts", "market", "sync", "--to", "pg", "--chunk-size", "1", "--json"], { cwd: process.cwd(), env });
      expect(resumed.exitCode).toBe(0);
      const verify = Bun.spawnSync([process.execPath, "run", "src/cli.ts", "market", "sync", "--to", "pg", "--verify", "--json"], { cwd: process.cwd(), env });
      expect(verify.exitCode).toBe(0);
      expect(JSON.parse(verify.stdout.toString()).data.ok).toBe(true);
    } finally {
      rmSync(home2, { recursive: true, force: true });
    }
  }, 60000);

  test("external tampering aborts the table with sync_conflict and zero rewrites", async () => {
    const baseline = invoke("market", "sync", "--to", "pg");
    expect(baseline.exit).toBe(0);
    const sql = admin();
    let tamperedRef = "";
    try {
      const rows = await sql.unsafe("SELECT ref FROM radar_archive.market_observations ORDER BY ref LIMIT 1");
      tamperedRef = (rows[0] as unknown as { ref: string }).ref;
      await sql.unsafe(
        "UPDATE radar_archive.market_observations SET payload = '{\"tampered\":true}', payload_digest = 'sha256:' || repeat('0', 64) WHERE ref = $1",
        [tamperedRef],
      );
    } finally {
      await sql.end({ timeout: 5 });
    }
    const conflicted = invoke("market", "sync", "--to", "pg");
    expect(conflicted.exit).toBe(1);
    expect(conflicted.body.error.code).toBe("sync_conflict");
    expect(conflicted.body.error.message).toContain("market_observations");
    expect(conflicted.body.error.message).toContain(tamperedRef);
    expect(conflicted.body.error.message).toMatch(/sha256:[0-9a-f]{12}/);
    // The tampered row is still exactly what the external actor left: the
    // sync never updates or deletes archived rows, even when aborting.
    const sql2 = admin();
    try {
      const rows = await sql2.unsafe("SELECT payload FROM radar_archive.market_observations WHERE ref = $1", [tamperedRef]);
      expect((rows[0] as unknown as { payload: string }).payload).toBe('{"tampered":true}');
    } finally {
      await sql2.end({ timeout: 5 });
    }
    // Verify reports the divergence and exits non-zero without writing.
    const verify = invoke("market", "sync", "--to", "pg", "--verify");
    expect(verify.exit).toBe(1);
    expect(verify.body.error.code).toBe("verify_diverged");
    expect(verify.body.data.differences.some((d: { kind: string }) => d.kind === "digest_mismatch")).toBe(true);
    // Owner repair for the next scenarios: restore the row from the source
    // by deleting the tampered copy (an explicit owner action, never the CLI).
    const sql3 = admin();
    try {
      await sql3.unsafe("DELETE FROM radar_archive.market_observations WHERE ref = $1", [tamperedRef]);
    } finally {
      await sql3.end({ timeout: 5 });
    }
  }, 60000);

  test("a changed target fingerprint refuses to resume without explicit confirmation", async () => {
    // Simulate a different stored target line directly in the cursor table.
    const sqlite = new Database(dbPath);
    sqlite.exec("UPDATE market_sync_state SET target_fingerprint = '" + "deadbeef".repeat(8) + "'");
    sqlite.close();
    const refused = invoke("market", "sync", "--to", "pg");
    expect(refused.exit).toBe(1);
    expect(refused.body.error.code).toBe("sync_target_changed");
    expect(refused.body.error.message).toContain("--allow-target-change");
    expect(JSON.stringify(refused.body)).not.toContain("postgres://");
    const confirmed = invoke("market", "sync", "--to", "pg", "--allow-target-change");
    expect(confirmed.exit).toBe(0);
    // Fresh replay against the same archive: everything replays as reused.
    expect(confirmed.body.facts.rows_synced).toBe(1); // the owner-restored observation row above
    expect(confirmed.body.facts.rows_reused).toBeGreaterThan(0);
    const verify = invoke("market", "sync", "--to", "pg", "--verify");
    expect(verify.exit).toBe(0);
  }, 60000);

  test("a corrupt cursor fails with cursor_invalid and --reset-cursor replays idempotently", async () => {
    const sqlite = new Database(dbPath);
    sqlite.exec("UPDATE market_sync_state SET cursor_json = 'not-json' WHERE table_name = 'market_batches'");
    sqlite.close();
    const refused = invoke("market", "sync", "--to", "pg");
    expect(refused.exit).toBe(1);
    expect(refused.body.error.code).toBe("cursor_invalid");
    expect(refused.body.error.message).toContain("--reset-cursor --confirm-reset");
    const replayed = invoke("market", "sync", "--to", "pg", "--reset-cursor", "--confirm-reset");
    expect(replayed.exit).toBe(0);
    expect(replayed.body.facts.rows_synced).toBe(0);
    expect(replayed.body.facts.rows_reused).toBeGreaterThan(0);
    const verify = invoke("market", "sync", "--to", "pg", "--verify");
    expect(verify.exit).toBe(0);
    expect(verify.body.data.ok).toBe(true);
  }, 60000);
}
