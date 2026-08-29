#!/usr/bin/env bun
// Integration test evidence runner: wraps the given test command, captures
// summary.json / command.txt / stdout.log / stderr.log / env.json / artifacts/,
// redacts secrets, and exits with the original code.
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";

const REDACT = [/(authorization:\s*bearer\s+)[\w.-]+/gi, /(cookie:\s*)[^\n]+/gi, /(token=)[\w.-]+/gi];

function redact(s: string): string {
  return REDACT.reduce((acc, re) => acc.replace(re, "$1[REDACTED]"), s);
}

const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
const dir = join("temp", "integration-test-runs", runId);
mkdirSync(join(dir, "artifacts"), { recursive: true });

const [cmd, ...args] = process.argv.slice(2);
const startedAt = new Date().toISOString();
const proc = spawnSync(cmd, args, { encoding: "utf8", env: process.env, stdio: ["inherit", "pipe", "pipe"] });
const finishedAt = new Date().toISOString();

writeFileSync(join(dir, "command.txt"), redact([cmd, ...args].join(" ")));
writeFileSync(join(dir, "stdout.log"), redact(proc.stdout ?? ""));
writeFileSync(join(dir, "stderr.log"), redact(proc.stderr ?? ""));
const env = Object.fromEntries(
  Object.entries(process.env)
    .filter(([k]) => !/token|key|secret|cookie|pass/i.test(k))
    .sort(([a], [b]) => a.localeCompare(b)),
);
writeFileSync(join(dir, "env.json"), JSON.stringify(env, null, 2));

const summary = {
  runId,
  command: [cmd, ...args].join(" "),
  startedAt,
  finishedAt,
  exitCode: proc.status ?? proc.signal ?? -1,
  cwd: process.cwd(),
};
writeFileSync(join(dir, "summary.json"), JSON.stringify(summary, null, 2));

// Best-effort artifact sweep: copy fresh files under test/fixtures if the test wrote any.
try {
  for (const f of readdirSync("test/fixtures")) {
    const p = join("test/fixtures", f);
    if (statSync(p).isFile() && statSync(p).mtimeMs > Date.now() - 10 * 60_000) {
      copyFileSync(p, join(dir, "artifacts", f));
    }
  }
} catch {
  // fixture dir may not exist in some runs; evidence capture must not fail the run
}

process.stdout.write(proc.stdout ?? "");
process.stderr.write(proc.stderr ?? "");
console.error(`[evidence] ${dir}`);
process.exit(proc.status ?? 1);
