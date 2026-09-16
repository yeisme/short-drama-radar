#!/usr/bin/env bun
// Read-only project delivery inventory, not a domain task service or completion receipt.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { renderAgentLine, renderExplain, renderJsonEnvelope, renderSummary, type CommandResult } from "../src/output/envelope.ts";
import { EventWriter } from "../src/output/events.ts";

export function taskDeclaration(text: string) {
  const tasks = [...text.matchAll(/^\s*- \[([ xX])\]\s+(\d+(?:\.\d+)+)(?=\D|$)/gm)];
  const ids = tasks.map(t => t[2]!);
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate task identifiers require review.");
  return { total: tasks.length, checked: tasks.filter(t => t[1] !== " ").length,
    unchecked_ids: tasks.filter(t => t[1] === " ").map(t => t[2]!),
    declaration: !tasks.length ? "missing_tasks" : tasks.every(t => t[1] !== " ") ? "all_checked" : "open_tasks" };
}
const digest = (text: string) => "sha256:" + createHash("sha256").update(text).digest("hex");
const safeId = (text: string) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,180}$/.test(text);

export function deliveryStatus(root: string, evidenceId?: string) {
  const changesRoot = join(root, "openspec/changes");
  const scan = (directory: string, archived: boolean) => readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name !== "archive").sort((a, b) => a.name.localeCompare(b.name)).map(entry => {
      if (!safeId(entry.name)) throw new Error("Invalid change directory name.");
      const path = join(directory, entry.name, "tasks.md");
      const content = existsSync(path) ? readFileSync(path, "utf8") : "";
      return { change: entry.name, archived, path: relative(root, path), tasks_digest: digest(content), ...taskDeclaration(content) };
    });
  const changes = [...scan(changesRoot, false), ...(existsSync(join(changesRoot, "archive")) ? scan(join(changesRoot, "archive"), true) : [])];
  let verification = null;
  if (evidenceId !== undefined) {
    if (!safeId(evidenceId)) throw new Error("Use an evidence run identifier, not a path.");
    const directory = join(root, "temp/integration-test-runs", evidenceId);
    for (const file of ["summary.json", "command.txt", "stdout.log", "stderr.log", "env.json"]) {
      if (!statSync(join(directory, file)).isFile()) throw new Error("Incomplete evidence directory.");
    }
    if (!statSync(join(directory, "artifacts")).isDirectory()) throw new Error("Missing evidence artifacts directory.");
    const raw = readFileSync(join(directory, "summary.json"), "utf8"), summary = JSON.parse(raw);
    if (summary.schema_version !== "yeisme.integration_test_evidence.v1" || summary.project !== "cli/short-drama-radar" ||
      summary.run_id !== evidenceId || !["passed", "failed"].includes(summary.status) || !Number.isSafeInteger(summary.exit_code) ||
      (summary.status === "passed") !== (summary.exit_code === 0) || summary.redaction?.enabled !== true) {
      throw new Error("Invalid evidence summary.");
    }
    const output = readFileSync(join(directory, "stdout.log"), "utf8") + "\n" + readFileSync(join(directory, "stderr.log"), "utf8");
    const count = (name: string) => [...output.matchAll(new RegExp(`^\\s*(\\d+) ${name}\\s*$`, "gm"))].at(-1)?.[1];
    verification = { run_id: evidenceId, summary_digest: digest(raw), status: summary.status, exit_code: summary.exit_code,
      test_counts: { pass: count("pass") === undefined ? null : Number(count("pass")),
        fail: count("fail") === undefined ? null : Number(count("fail")), skip: count("skip") === undefined ? null : Number(count("skip")) },
      pg_skip_reported: /pg_integration_skipped/.test(output),
      disposable_pg_reported: output.includes("Real PostgreSQL target: disposable loopback cluster"),
      scope: "supplied_run_only_not_current_tree_certification" };
  }
  const active = changes.filter(c => !c.archived);
  return { spec: "radar.delivery_inventory.v1", project_complete: false,
    active_changes: active.length, unchecked_tasks: active.reduce((n, c) => n + c.unchecked_ids.length, 0),
    closeout_candidates: active.filter(c => c.declaration === "all_checked").map(c => c.change),
    changes, verification,
    limitations: ["Task checkboxes and archives are declarations, not independent verification.",
      "A supplied test run does not certify changed files, market demand, live sources or deployment.",
      "Business completion requires source qualification, real observation and explicit product review; consult the delivery DAG."] };
}

if (import.meta.main) {
  const args = process.argv.slice(2), modes = ["--json", "--agent", "--events", "--explain"];
  const mode = modes.find(m => args.includes(m));
  const events = mode === "--events" ? new EventWriter(crypto.randomUUID()) : undefined;
  const command = "radar.project.delivery-status";
  events?.start(command);
  let result: CommandResult;
  try {
    let evidence: string | undefined;
    let selectedMode = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (modes.includes(arg) && !selectedMode) { selectedMode = true; continue; }
      if (arg === "--evidence" && evidence === undefined && args[i + 1] && safeId(args[i + 1]!)) { evidence = args[++i]; continue; }
      if (arg === "--help" && args.length === 1) {
        console.log("Usage: bun run scripts/delivery-status.ts [--evidence <run-id>] [--json|--agent|--events|--explain]\nRead-only OpenSpec inventory; all_checked is not verified completion."); process.exit(0);
      }
      throw new Error("Invalid flags.");
    }
    const data = deliveryStatus(join(import.meta.dir, ".."), evidence);
    result = { command, status: "partial", summary: "Delivery inventory is available; project validation remains incomplete.",
      facts: { active_changes: data.active_changes, unchecked_tasks: data.unchecked_tasks, project_complete: false,
        closeout_candidates: data.closeout_candidates.join(","), verification_status: data.verification?.status ?? "not_supplied" },
      data, exitCode: 0, actions: [{ name: "plan", command: "cat docs/product/greenlight-pilot/delivery-dag.md" }] };
  } catch {
    result = { command, status: "failed", summary: "Cannot inspect delivery inventory.",
      error: { code: "delivery_inventory_invalid", message: "Check task identifiers, evidence completeness and flags; use --help." }, exitCode: 1 };
  }
  if (events) {
    if (result.error) events.error(result.error.code, result.error.message); else events.end(result.status, result.facts);
  } else console.log(mode === "--json" ? JSON.stringify(renderJsonEnvelope(result)) : mode === "--agent" ? renderAgentLine(result)
    : mode === "--explain" ? renderExplain(result) : renderSummary(result));
  process.exitCode = result.exitCode;
}
