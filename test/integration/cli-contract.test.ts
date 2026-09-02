import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Process-level CLI contract: every --json emission validates against the
// standard envelope, --agent lines parse, failures keep non-zero exit codes,
// and --events streams carry seq/run_id with a final end|error event.

const CLI = join(import.meta.dir, "../../src/cli.ts");

interface ProcResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runCli(home: string, args: string[]): ProcResult {
  const proc = Bun.spawnSync([process.execPath, CLI, ...args], {
    env: { ...process.env, RADAR_HOME: home, RADAR_DB_PATH: join(home, "radar.db"), RADAR_FIXTURE_DIR: join(import.meta.dir, "../fixtures") },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode ?? -1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

describe("CLI output contract (--json)", () => {
  test("help describes the actual full daily pipeline", () => {
    const home = mkdtempSync(join(tmpdir(), "radar-cli-"));
    const { stdout, exitCode } = runCli(home, ["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("collect -> score -> cluster -> card + edition");
    expect(stdout).toContain("canary report [window-days]");
    expect(stdout).not.toContain("run                              collect -> score -> card\n");
    expect(stdout).toContain("Probe MCP SDK / database / audit backing state");
    expect(stdout).not.toContain("lands with M3");
  });

  test("all command emissions validate as standard envelopes", () => {
    const home = mkdtempSync(join(tmpdir(), "radar-cli-"));
    const { validateEnvelope } = require("../../src/output/envelope.ts");
    const outputs: string[] = [];
    runCli(home, ["profile", "create", "--name", "p1"]);
    outputs.push(runCli(home, ["profile", "show", "--json"]).stdout);
    outputs.push(runCli(home, ["card", "--json"]).stdout);
    outputs.push(runCli(home, ["runs", "--json"]).stdout);
    outputs.push(runCli(home, ["health", "7", "--json"]).stdout);
    outputs.push(runCli(home, ["canary", "report", "14", "--json"]).stdout);
    for (const out of outputs) {
      const env = JSON.parse(out);
      const result = validateEnvelope(env);
      expect(result.problems).toEqual([]);
      expect(env.spec_version).toBe("1.0");
      expect(env.command.startsWith("radar.")).toBe(true);
    }
  });

  test("collect --json envelope carries degraded facts without failing", () => {
    const home = mkdtempSync(join(tmpdir(), "radar-cli-"));
    const { exitCode, stdout } = runCli(home, ["collect", "--json"]);
    expect(exitCode).toBe(0); // degraded layers are partial, not failed
    const env = JSON.parse(stdout);
    expect(["success", "partial"]).toContain(env.status);
    expect(env.facts.degraded_layers).toContain("playwright-browser");
    expect(env.evidence.run_id).toMatch(/^collect-/);
  });

  test("unknown command fails with a non-zero exit and error envelope", () => {
    const home = mkdtempSync(join(tmpdir(), "radar-cli-"));
    const { exitCode, stdout } = runCli(home, ["frobnicate", "--json"]);
    expect(exitCode).not.toBe(0);
    const env = JSON.parse(stdout);
    expect(env.status).toBe("failed");
    expect(env.error.code).toBe("unknown_command");
  });
});

describe("CLI --agent renderer", () => {
  test("single key=value line with the mandatory keys", () => {
    const home = mkdtempSync(join(tmpdir(), "radar-cli-"));
    runCli(home, ["profile", "create", "--name", "p1"]);
    const { stdout, exitCode } = runCli(home, ["profile", "show", "--agent"]);
    expect(exitCode).toBe(0);
    expect(stdout.trim().split("\n")).toHaveLength(1);
    const kv = Object.fromEntries(stdout.trim().split(" ").map((p) => p.split("=")));
    expect(kv.spec_version).toBe("1.0");
    expect(kv.mode).toBe("agent");
    expect(kv.command).toBe("radar.profile.show");
    expect(kv.status).toBe("success");
    expect(kv.data_ref).toMatch(/^radar-data-/);
  });
});

describe("CLI --events stream (collect)", () => {
  test("NDJSON lines with monotonic seq, stable run_id, final end event", () => {
    const home = mkdtempSync(join(tmpdir(), "radar-cli-"));
    const { stdout, exitCode } = runCli(home, ["collect", "--events"]);
    expect(exitCode).toBe(0);
    const lines = stdout.trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(4);
    const events = lines.map((l) => JSON.parse(l));
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    const runIds = new Set(events.map((e) => e.run_id));
    expect(runIds.size).toBe(1);
    expect(events[0].event).toBe("start");
    const last = events[events.length - 1];
    expect(["end", "error"]).toContain(last.event);
    expect(last.event).toBe("end");
    expect(last.status).toBe("partial"); // fixture run: layer 2 skipped
  });
});

describe("profile commands (process)", () => {
  test("profile_required before any profile exists", () => {
    const home = mkdtempSync(join(tmpdir(), "radar-cli-"));
    const { exitCode, stdout } = runCli(home, ["profile", "show", "--json"]);
    expect(exitCode).not.toBe(0);
    const env = JSON.parse(stdout);
    expect(env.error.code).toBe("profile_required");
    expect(env.error.message).toContain("radar profile create");
  });

  test("named profiles stay isolated; activation is exclusive", () => {
    const home = mkdtempSync(join(tmpdir(), "radar-cli-"));
    runCli(home, ["profile", "create", "--name", "a"]);
    runCli(home, ["profile", "create", "--name", "b"]); // not auto-active
    const showA = JSON.parse(runCli(home, ["profile", "show", "--profile", "profile-a", "--json"]).stdout);
    const showDefault = JSON.parse(runCli(home, ["profile", "show", "--json"]).stdout);
    expect(showA.data.blocked_topics).toEqual([]);
    expect(showDefault.facts.ref).toBe("profile-a"); // a still the single active
    runCli(home, ["profile", "activate", "profile-b"]);
    const after = JSON.parse(runCli(home, ["profile", "show", "--json"]).stdout);
    expect(after.facts.ref).toBe("profile-b");
    expect(after.facts.active).toBe(true);
  });

  test("set creates immutable revisions", () => {
    const home = mkdtempSync(join(tmpdir(), "radar-cli-"));
    runCli(home, ["profile", "create", "--name", "c", "--risk-tolerance", "10"]);
    const r1 = JSON.parse(runCli(home, ["profile", "show", "--json"]).stdout);
    runCli(home, ["profile", "set", "--risk-tolerance", "55", "--blocked-topic", "taboo"]);
    const r2 = JSON.parse(runCli(home, ["profile", "show", "--json"]).stdout);
    expect(r2.facts.revision).toBe(r1.facts.revision + 1);
    expect(r2.data.risk_tolerance).toBe(55);
    expect(r2.data.blocked_topics).toEqual(["taboo"]);
    expect(r2.facts.digest).not.toBe(r1.facts.digest);
  });
});

describe("doctor probes", () => {
  test("doctor reports blocked/unavailable states honestly, never fake-ready", () => {
    const home = mkdtempSync(join(tmpdir(), "radar-cli-"));
    const { stdout, exitCode } = runCli(home, ["doctor", "--json"]);
    expect(exitCode).toBe(0);
    const env = JSON.parse(stdout);
    const checks = env.data;
    // Fixture-mode firecrawl endpoint is unreachable in tests -> degraded.
    expect(["ok", "degraded"]).toContain(checks.firecrawl.status);
    expect(["blocked", "ok"]).toContain(checks["xhs-backend"].status);
    expect(checks["douyin-cookie"].status).toBe("blocked");
    if (checks["xhs-backend"].status === "blocked") {
      expect(checks["xhs-backend"].nextCommand).toMatch(/agent-reach|xiaohongshu-mcp|get_login_qrcode/);
    }
    expect(checks.playwright.status).toBe("unavailable");
    expect(checks.playwright.nextCommand).toBe("bun add playwright");
  });

  test("mcp capabilities discloses ready/planned/blocked honestly", () => {
    const home = mkdtempSync(join(tmpdir(), "radar-cli-"));
    const { exitCode, stdout } = runCli(home, ["mcp", "capabilities", "--json"]);
    expect(exitCode).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.status).toBe("success");
    const caps = Object.fromEntries(env.data.map((c: { capability: string; status: string }) => [c.capability, c.status]));
    expect(caps["mcp_stdio_lanes"]).toBe("ready");
    expect(caps["remote_mcp_endpoint"]).toBe("unavailable");
    expect(caps["a2a"]).toBe("unavailable");
    expect(caps["multi_user"]).toBe("unavailable");
    expect(caps["hermes_local_canary"]).toBe("planned");
  });

  test("unsupported transport fails closed with the proposal gate", () => {
    const home = mkdtempSync(join(tmpdir(), "radar-cli-"));
    const { exitCode, stdout } = runCli(home, ["mcp", "--transport", "http", "--json"]);
    expect(exitCode).not.toBe(0);
    const env = JSON.parse(stdout);
    expect(env.error.code).toBe("transport_unsupported");
  });
});
