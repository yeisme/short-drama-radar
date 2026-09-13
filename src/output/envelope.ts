import { createHash } from "node:crypto";

// Standard CLI output contract (radar-cli-agent-contract spec).
// One CommandResult per command; four renderers (summary/json/agent/events)
// all derive from it. The private 0.0.x `{ok, app, command, data, errors}`
// draft is retired in this change — its frozen fixture lives in
// test/fixtures/envelope-legacy-0.0.1.json as migration evidence.

export const ENVELOPE_SPEC_VERSION = "1.0" as const;

export type CommandStatus = "success" | "partial" | "failed";

export interface CommandAction {
  name: string;
  command: string;
}

export interface CommandError {
  code: string; // stable machine code, e.g. profile_required
  message: string; // human-readable, secret-free
}

export interface CommandResult<T = unknown> {
  command: string; // canonical command id, e.g. "radar.collect"
  status: CommandStatus;
  summary: string; // one short English line
  facts?: Record<string, unknown>; // scalar facts (degraded flags live here)
  actions?: CommandAction[];
  evidence?: string[]; // refs/digests pointing at receipts
  confidence?: number; // 0..1, optional
  data?: T; // command payload
  error?: CommandError;
  exitCode: number; // non-zero on failed
}

export interface Envelope<T = unknown> {
  spec_version: typeof ENVELOPE_SPEC_VERSION;
  mode: "json";
  command: string;
  status: CommandStatus;
  summary: string;
  facts?: Record<string, unknown>;
  actions?: CommandAction[];
  evidence?: string[];
  confidence?: number;
  data?: T;
  error?: CommandError;
}

export function renderJsonEnvelope<T>(result: CommandResult<T>): Envelope<T> {
  const envelope: Envelope<T> = {
    spec_version: ENVELOPE_SPEC_VERSION,
    mode: "json",
    command: result.command,
    status: result.status,
    summary: result.summary,
  };
  if (result.facts && Object.keys(result.facts).length > 0) envelope.facts = result.facts;
  if (result.actions && result.actions.length > 0) envelope.actions = result.actions;
  if (result.evidence && result.evidence.length > 0) envelope.evidence = result.evidence;
  if (typeof result.confidence === "number") envelope.confidence = result.confidence;
  if (result.data !== undefined) envelope.data = result.data;
  if (result.error) envelope.error = result.error;
  return envelope;
}

// Envelope validator: strict top-level shape, used by contract tests so every
// command stays on the standard surface.
export function validateEnvelope(value: unknown): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (typeof value !== "object" || value === null) return { ok: false, problems: ["envelope is not an object"] };
  const env = value as Record<string, unknown>;
  const allowed = new Set(["spec_version", "mode", "command", "status", "summary", "facts", "actions", "evidence", "confidence", "data", "error"]);
  for (const key of Object.keys(env)) {
    if (!allowed.has(key)) problems.push(`unexpected top-level key '${key}'`);
  }
  if (env["spec_version"] !== "1.0") problems.push("spec_version must be '1.0'");
  if (env["mode"] !== "json") problems.push("mode must be 'json'");
  if (typeof env["command"] !== "string" || !env["command"].startsWith("radar.")) problems.push("command must be a radar.<id> string");
  if (!["success", "partial", "failed"].includes(String(env["status"]))) problems.push("status must be success|partial|failed");
  if (typeof env["summary"] !== "string") problems.push("summary must be a string");
  if (env["facts"] !== undefined && (typeof env["facts"] !== "object" || Array.isArray(env["facts"]))) problems.push("facts must be an object");
  if (env["actions"] !== undefined && !Array.isArray(env["actions"])) problems.push("actions must be an array");
  if (env["confidence"] !== undefined && !(typeof env["confidence"] === "number" && env["confidence"] >= 0 && env["confidence"] <= 1)) problems.push("confidence must be 0-1");
  if (env["error"] !== undefined) {
    const err = env["error"] as Record<string, unknown>;
    if (typeof err["code"] !== "string" || typeof err["message"] !== "string") problems.push("error must have code and message strings");
  }
  if (env["status"] === "failed" && !env["error"]) problems.push("failed status requires an error object");
  return { ok: problems.length === 0, problems };
}

// --agent renderer: stable key=value, one per line. Big payloads become refs
// so values stay greppable; values containing spaces are quoted.
export function renderAgentLine(result: CommandResult): string {
  const lines = [
    `spec_version=${ENVELOPE_SPEC_VERSION}`,
    "mode=agent",
    `command=${result.command}`,
    `status=${result.status}`,
  ];
  if (result.summary) lines.push(`summary=${agentValue(result.summary)}`);
  if (result.facts) {
    for (const [k, v] of Object.entries(result.facts)) {
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") lines.push(`fact.${k}=${agentValue(String(v))}`);
    }
  }
  if (result.error) lines.push(`error.code=${result.error.code}`);
  if (typeof result.confidence === "number") lines.push(`confidence=${result.confidence}`);
  if (result.data !== undefined && result.data !== null && typeof result.data === "object") {
    const ref = dataRef(result.data);
    if (ref) lines.push(`data_ref=${ref}`);
  }
  const firstAction = result.actions?.[0];
  if (firstAction) lines.push(`action.next=${agentValue(firstAction.command)}`);
  return lines.join("\n");
}

function agentValue(v: string): string {
  const sanitized = sanitize(v);
  if (/\s/.test(sanitized)) return JSON.stringify(sanitized);
  return sanitized;
}

function sanitize(v: string): string {
  return v.replace(/[\n\r=]/g, " ").trim();
}

function dataRef(data: unknown): string | null {
  const hash = createHash("sha256").update(JSON.stringify(data)).digest("hex").slice(0, 16);
  return `radar-data-${hash}`;
}

// --explain renderer: an English, reviewable reasoning summary derived from
// the same CommandResult. Conclusions cite evidence refs; without evidence
// they are explicitly marked as hypotheses. Never chain-of-thought.
export function renderExplain(result: CommandResult): string {
  const lines: string[] = [];
  lines.push(`Conclusion: ${result.summary}`);
  const evidence = [
    ...(result.evidence ?? []),
    ...Object.entries(result.facts ?? {}).map(([k, v]) => typeof v === "object" ? null : `${k}=${v}`).filter(Boolean) as string[],
  ];
  lines.push(evidence.length ? `Evidence: ${evidence.join("; ")}` : "Evidence: none recorded; the conclusion above is a hypothesis, not a verified fact.");
  if (typeof result.confidence === "number") lines.push(`Confidence: ${result.confidence}`);
  if (result.error) lines.push(`Risks: ${result.error.code} — ${result.error.message}`);
  const first = result.actions?.[0];
  lines.push(`Recommended next step: ${first ? first.command : "no further action required"}`);
  return lines.join("\n");
}

// Default human summary: short lines, one primary next command.
export function renderSummary(result: CommandResult): string {
  const lines = [`== ${result.command} ${result.status} ==`, result.summary];
  if (result.facts) {
    for (const [k, v] of Object.entries(result.facts)) {
      if (typeof v === "object") continue;
      lines.push(`${k}: ${v}`);
    }
  }
  if (result.error) lines.push(`error: ${result.error.code} — ${result.error.message}`);
  const first = result.actions?.[0];
  if (first) lines.push(`next: ${first.command}`);
  return lines.join("\n");
}
