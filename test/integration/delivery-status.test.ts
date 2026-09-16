import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deliveryStatus } from "../../scripts/delivery-status.ts";
import { runWithEvidence } from "../../scripts/integration-test-run.ts";
import { validateEnvelope } from "../../src/output/envelope.ts";

const homes: string[] = [];
afterEach(() => homes.splice(0).forEach(h => rmSync(h, { recursive: true, force: true })));
test("inventory never turns checked declarations or passing test evidence into project completion", () => {
  const home = mkdtempSync(join(tmpdir(), "radar-delivery-")); homes.push(home);
  mkdirSync(join(home, "openspec/changes/ready"), { recursive: true });
  mkdirSync(join(home, "openspec/changes/missing"));
  // Test fixtures model source declarations, not real task completion records.
  writeFileSync(join(home, "openspec/changes/ready/tasks.md"), "- [x] 1.1 Test declaration\n");
  const evidence = runWithEvidence({ command: process.execPath, args: ["-e", "console.log('1 pass\\n0 fail\\npg_integration_skipped')"], cwd: home, runId: "fixture" });
  expect(evidence.exitCode).toBe(0);
  const status = deliveryStatus(home, "fixture");
  expect(status.closeout_candidates).toEqual(["ready"]);
  expect(status.changes.find(c => c.change === "missing")!.declaration).toBe("missing_tasks");
  expect(status.verification!.pg_skip_reported).toBe(true);
  expect(status.verification!.test_counts.pass).toBe(1);
  expect(status.project_complete).toBe(false);
  expect(() => deliveryStatus(home, "../fixture")).toThrow("not a path");
  rmSync(join(evidence.directory, "env.json"));
  expect(() => deliveryStatus(home, "fixture")).toThrow();
});

test("inventory CLI offers safe standard modes and rejects arbitrary evidence paths", () => {
  const run = (...args: string[]) => Bun.spawnSync([process.execPath, "run", "scripts/delivery-status.ts", ...args], { cwd: join(import.meta.dir, "../..") });
  const json = run("--json");
  expect(json.exitCode).toBe(0);
  const envelope = JSON.parse(json.stdout.toString());
  expect(validateEnvelope(envelope).ok).toBe(true);
  expect(envelope.status).toBe("partial");
  expect(envelope.data.project_complete).toBe(false);
  for (const mode of ["--agent", "--explain", "--events"]) expect(run(mode).exitCode).toBe(0);
  const bad = run("--evidence", "../../private", "--json");
  expect(bad.exitCode).toBe(1);
  expect(JSON.parse(bad.stdout.toString()).error.code).toBe("delivery_inventory_invalid");
  expect(bad.stdout.toString()).not.toContain("../../private");
});

test("evidence runner redacts returned output as well as persisted output", () => {
  const home = mkdtempSync(join(tmpdir(), "radar-redacted-")); homes.push(home);
  const result = runWithEvidence({ command: process.execPath, args: ["-e", "console.log('postgres://test:synthetic-password@localhost/db'); process.exit(3)"], cwd: home });
  expect(result.exitCode).toBe(3);
  expect(result.stdout).toContain("[REDACTED]");
  expect(result.stdout).not.toContain("synthetic-password");
});
