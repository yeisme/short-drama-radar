#!/usr/bin/env bun
// Project-owned disposable PG verification. Never consumes a configured DSN.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createServer } from "node:net";
import { runWithEvidence } from "./integration-test-run.ts";

const root = join(import.meta.dir, "..");
const args = process.argv.slice(2);
if (args.some(arg => !["--all", "--execute", "--help"].includes(arg)) || new Set(args).size !== args.length) {
  process.stderr.write("Usage: bun run scripts/test-local-pg.ts [--all]\n"); process.exit(2);
}
if (args.includes("--help")) {
  process.stdout.write("Usage: bun run scripts/test-local-pg.ts [--all]\nStarts an isolated loopback PostgreSQL cluster, runs tests with evidence, then stops and removes only that cluster. Requires initdb and pg_ctl. --all runs the full suite.\n");
  process.exit(0);
}
if (!args.includes("--execute")) {
  const result = runWithEvidence({ command: process.execPath,
    args: ["run", "scripts/test-local-pg.ts", "--execute", ...(args.includes("--all") ? ["--all"] : [])], cwd: root });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr);
  process.stderr.write(`[evidence] ${relative(root, result.directory)}\n`);
  process.exit(result.exitCode);
}

let directory: string | undefined, started = false, cleaned = false;
function command(name: string, values: string[], timeout = 30000) {
  return spawnSync(name, values, { cwd: root, encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] });
}
function cleanup() {
  if (cleaned || !directory) return;
  cleaned = true;
  if (started) {
    const stop = command("pg_ctl", ["-D", join(directory, "data"), "-m", "immediate", "-w", "-t", "15", "stop"]);
    if (stop.status !== 0) {
      process.stderr.write("Disposable PostgreSQL stop failed; its temporary directory was retained for recovery.\n");
      process.exitCode = 1; return;
    }
  }
  rmSync(directory, { recursive: true, force: true });
}
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));
try {
  for (const tool of ["initdb", "pg_ctl"]) {
    if (command(tool, ["--version"]).status !== 0) throw new Error("PostgreSQL tools are unavailable; install initdb and pg_ctl locally.");
  }
  directory = mkdtempSync(join(tmpdir(), "radar-disposable-pg-"));
  const data = join(directory, "data");
  if (command("initdb", ["-D", data, "--username=radar_test", "--auth=trust", "--no-locale", "--encoding=UTF8"]).status !== 0) {
    throw new Error("Disposable PostgreSQL initialization failed; use a non-root local account.");
  }
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Cannot allocate a loopback port.");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  // The port reservation has a small race; a collision fails startup, never
  // reuses another server. pg_ctl controls only our newly initialized directory.
  started = true;
  if (command("pg_ctl", ["-D", data, "-l", join(directory, "server.log"), "-o", `-h 127.0.0.1 -p ${port} -k ${directory}`, "-w", "-t", "15", "start"]).status !== 0) {
    throw new Error("Disposable PostgreSQL startup failed.");
  }
  process.stdout.write("Real PostgreSQL target: disposable loopback cluster; configured targets are ignored.\n");
  const suite = spawnSync(process.execPath, ["test", ...(args.includes("--all") ? [] : ["test/integration/market-pg-sync.test.ts"]), "--timeout", "60000"], {
    cwd: root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, RADAR_TEST_PG_URL: `postgres://radar_test@127.0.0.1:${port}/postgres`, RADAR_TEST_PG_DISPOSABLE: "1" },
  });
  process.stdout.write(suite.stdout ?? ""); process.stderr.write(suite.stderr ?? "");
  process.exitCode = suite.status ?? 1;
} catch (error) {
  process.stderr.write(error instanceof Error && error.message.startsWith("Disposable PostgreSQL") ? error.message + "\n" : "Local PostgreSQL verification failed; check installed tools and loopback availability.\n");
  process.exitCode = 1;
} finally { cleanup(); }
