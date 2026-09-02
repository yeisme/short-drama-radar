import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactEvidence, runWithEvidence } from "../../scripts/integration-test-run.ts";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("integration evidence runner", () => {
  test("writes the required schema and only allowlisted environment metadata", () => {
    const root = temporaryDirectory();
    const result = runWithEvidence({
      command: process.execPath,
      args: ["-e", "process.stdout.write('ok')"],
      cwd: root,
      evidenceRoot: "evidence",
      runId: "success",
      env: { ...process.env, RADAR_FIXTURE_DIR: "test/fixtures", SUPER_SECRET_TOKEN: "must-not-persist" },
    });

    expect(result.exitCode).toBe(0);
    const summary = JSON.parse(readFileSync(join(result.directory, "summary.json"), "utf8"));
    expect(summary).toMatchObject({
      schema_version: "yeisme.integration_test_evidence.v1",
      project: "cli/short-drama-radar",
      run_id: "success",
      layer: "integration",
      status: "passed",
      exit_code: 0,
      redaction: { enabled: true, policy: "yeisme.integration_test_evidence.v1" },
    });
    expect(summary.duration_ms).toBeGreaterThanOrEqual(0);
    expect(existsSync(join(result.directory, "artifacts"))).toBe(true);
    expect(readFileSync(join(result.directory, "stdout.log"), "utf8")).toBe("ok");

    const environment = readFileSync(join(result.directory, "env.json"), "utf8");
    expect(environment).toContain('"fixture_mode": true');
    expect(environment).not.toContain("SUPER_SECRET_TOKEN");
    expect(environment).not.toContain("must-not-persist");
  });

  test("preserves a failing command exit code and redacts persisted output", () => {
    const root = temporaryDirectory();
    const result = runWithEvidence({
      command: process.execPath,
      args: ["-e", "process.stderr.write('Authorization: Bearer live-token\\npassword=hunter2'); process.exit(7)"],
      cwd: root,
      evidenceRoot: "evidence",
      runId: "failure",
    });

    expect(result.exitCode).toBe(7);
    const summary = JSON.parse(readFileSync(join(result.directory, "summary.json"), "utf8"));
    expect(summary.status).toBe("failed");
    expect(summary.exit_code).toBe(7);
    const stderr = readFileSync(join(result.directory, "stderr.log"), "utf8");
    expect(stderr).toContain("Authorization: Bearer [REDACTED]");
    expect(stderr).toContain("password=[REDACTED]");
    expect(stderr).not.toContain("live-token");
    expect(stderr).not.toContain("hunter2");
  });

  test("redacts secret-like command arguments", () => {
    expect(redactEvidence("tool --token=abc123 --api_key secret-value")).toBe(
      "tool --token=[REDACTED] --api_key [REDACTED]",
    );
  });

  test("the CLI wrapper exits with the wrapped command code", () => {
    const root = temporaryDirectory();
    const script = join(import.meta.dir, "../../scripts/integration-test-run.ts");
    const proc = spawnSync(process.execPath, [script, process.execPath, "-e", "process.exit(9)"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, RADAR_EVIDENCE_ROOT: join(root, "evidence") },
    });

    expect(proc.status).toBe(9);
    const [runId] = readdirSync(join(root, "evidence"));
    const summary = JSON.parse(readFileSync(join(root, "evidence", runId!, "summary.json"), "utf8"));
    expect(summary.exit_code).toBe(9);
    expect(summary.status).toBe("failed");
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "radar-evidence-runner-"));
  tempDirectories.push(directory);
  return directory;
}
