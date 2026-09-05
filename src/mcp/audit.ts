import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

// radar.mcp.audit.v1 — append-only JSONL audit ledger for MCP tool calls.
// Written BEFORE the tool result is returned. The only read surface is
// `radar audit tail`; no MCP resource exposes audit content.

export const AUDIT_SPEC = "radar.mcp.audit.v1" as const;

export interface AuditEntry {
  spec: typeof AUDIT_SPEC;
  ts: string;
  principal_ref: string; // masked client identity
  lane: string;
  tool: string;
  action: string;
  args_digest: string; // sha256 of canonical args — raw args never stored
  outcome: "success" | "denied" | "error";
  run_ref?: string;
  edition_ref?: string;
  // Present (true) when the mutation hit its natural key and returned the
  // existing receipt instead of creating a new one.
  idempotent_reuse?: boolean;
}

export function auditPath(home: string): string {
  return join(home, "mcp-audit.jsonl");
}

export function maskPrincipal(clientName: string | undefined): string {
  if (!clientName) return "client:unknown";
  const cleaned = clientName.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 12);
  return `client:${cleaned || "unknown"}#${createHash("sha256").update(clientName).digest("hex").slice(0, 6)}`;
}

export function argsDigest(args: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(args ?? {})).digest("hex").slice(0, 16)}`;
}

export function appendAudit(home: string, entry: Omit<AuditEntry, "spec" | "ts">): AuditEntry {
  const full: AuditEntry = { spec: AUDIT_SPEC, ts: new Date().toISOString(), ...entry };
  appendFileSync(auditPath(home), JSON.stringify(full) + "\n");
  return full;
}

export function tailAudit(home: string, opts: { action?: string; limit?: number } = {}): AuditEntry[] {
  const path = auditPath(home);
  if (!existsSync(path)) return [];
  const limit = opts.limit ?? 20;
  const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  const entries: AuditEntry[] = [];
  for (const line of lines) {
    try {
      const e = JSON.parse(line) as AuditEntry;
      if (e.spec !== AUDIT_SPEC) continue; // foreign lines are skipped, never trusted
      if (opts.action && e.action !== opts.action) continue;
      entries.push(e);
    } catch {
      // malformed line: skipped; the ledger stays append-only
    }
  }
  return entries.slice(-limit);
}
