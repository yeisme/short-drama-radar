#!/usr/bin/env bun
// Integration test evidence runner: wraps one command, writes the repository
// evidence contract, redacts persisted output, and preserves the exit code.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const PROJECT = "cli/short-drama-radar";
const REDACTION_POLICY = "yeisme.integration_test_evidence.v1";
const REDACT_PATTERNS: Array<[RegExp, string]> = [
  [/(--(?:token|secret|api[_-]?key|password|cookie)(?:=|\s+))[^\s"']+/gi, "$1[REDACTED]"],
  [/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi, "$1[REDACTED]"],
  [/(cookie\s*[:=]\s*)[^\n\r]+/gi, "$1[REDACTED]"],
  [/(password\s*[:=]\s*)[^\s"']+/gi, "$1[REDACTED]"],
  [/((?:token|secret|api[_-]?key)\s*[:=]\s*)[^\s"']+/gi, "$1[REDACTED]"],
];

export function redactEvidence(value: string): string {
  return REDACT_PATTERNS.reduce((redacted, [pattern, replacement]) => redacted.replace(pattern, replacement), value);
}

export interface EvidenceRunOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  evidenceRoot?: string;
  runId?: string;
  layer?: "integration" | "component" | "system" | "e2e";
}

export interface EvidenceRunResult {
  runId: string;
  directory: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function runWithEvidence(options: EvidenceRunOptions): EvidenceRunResult {
  const args = options.args ?? [];
  const cwd = resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const evidenceRoot = resolve(cwd, options.evidenceRoot ?? join("temp", "integration-test-runs"));
  const runId = options.runId ?? `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
  const directory = join(evidenceRoot, runId);
  const artifactsDirectory = join(directory, "artifacts");
  mkdirSync(artifactsDirectory, { recursive: true });

  const started = new Date();
  const proc = spawnSync(options.command, args, {
    cwd,
    encoding: "utf8",
    env,
    stdio: ["inherit", "pipe", "pipe"],
    maxBuffer: 10 * 1024 * 1024,
  });
  const finished = new Date();
  const exitCode = proc.status ?? 1;
  const stdout = proc.stdout ?? "";
  const stderr = proc.stderr ?? proc.error?.message ?? "";
  const command = formatCommand(options.command, args);

  const paths = {
    summary: evidencePath(cwd, join(directory, "summary.json")),
    command: evidencePath(cwd, join(directory, "command.txt")),
    stdout: evidencePath(cwd, join(directory, "stdout.log")),
    stderr: evidencePath(cwd, join(directory, "stderr.log")),
    env: evidencePath(cwd, join(directory, "env.json")),
    artifacts: evidencePath(cwd, artifactsDirectory),
  };

  writeFileSync(join(directory, "command.txt"), `${redactEvidence(command)}\n`);
  writeFileSync(join(directory, "stdout.log"), redactEvidence(stdout));
  writeFileSync(join(directory, "stderr.log"), redactEvidence(stderr));
  writeFileSync(join(directory, "env.json"), `${JSON.stringify(safeEnvironment(env), null, 2)}\n`);

  const summary = {
    schema_version: REDACTION_POLICY,
    project: PROJECT,
    run_id: runId,
    layer: options.layer ?? "integration",
    command: redactEvidence(command),
    status: exitCode === 0 ? "passed" : "failed",
    exit_code: exitCode,
    started_at: started.toISOString(),
    finished_at: finished.toISOString(),
    duration_ms: finished.getTime() - started.getTime(),
    evidence: paths,
    redaction: {
      enabled: true,
      policy: REDACTION_POLICY,
    },
  };
  writeFileSync(join(directory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

  return { runId, directory, exitCode, stdout, stderr };
}

function safeEnvironment(env: NodeJS.ProcessEnv): Record<string, unknown> {
  return {
    schema_version: "yeisme.integration_test_environment.v1",
    platform: process.platform,
    arch: process.arch,
    runtime: {
      bun: typeof Bun !== "undefined" ? Bun.version : null,
      node: process.version,
    },
    ci: env.CI === "true" || env.CODEX_CI === "1",
    locale: env.LC_ALL ?? env.LANG ?? null,
    timezone: env.TZ ?? null,
    fixture_mode: Boolean(env.RADAR_FIXTURE_DIR),
    redaction: {
      enabled: true,
      policy: REDACTION_POLICY,
      environment_capture: "allowlisted-metadata-only",
    },
  };
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;
}

function evidencePath(cwd: string, path: string): string {
  if (!isAbsolute(path)) return path;
  const rel = relative(cwd, path);
  return rel.startsWith("..") ? path : rel || ".";
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    process.stderr.write("usage: bun run scripts/integration-test-run.ts -- <command> [args...]\n");
    process.exit(2);
  }
  const result = runWithEvidence({
    command,
    args,
    evidenceRoot: process.env.RADAR_EVIDENCE_ROOT,
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.stderr.write(`[evidence] ${evidencePath(process.cwd(), result.directory)}\n`);
  process.exit(result.exitCode);
}
