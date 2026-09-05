import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// MCP process e2e (task 3.9): real subprocess speaking JSON-RPC over stdio
// through the official SDK. Covers initialize/list/call/resource/prompt,
// lane rejection parity, audit-before-return, and reconnect-without-replay.

const CLI = join(import.meta.dir, "../../src/cli.ts");

interface RpcResponse {
  id: number | string;
  result?: Record<string, unknown> & { content?: Array<{ type: string; text: string }>; tools?: Array<{ name: string; description: string }>; resources?: Array<{ uri: string }>; resourceTemplates?: Array<{ uriTemplate: string }>; prompts?: Array<{ name: string }>; messages?: Array<{ role: string; content?: { type: string; text?: string } }>; contents?: Array<{ uri?: string; text?: string }> };
  error?: { code: number; message: string };
  messages?: Array<{ role: string; content?: { type: string; text?: string } }>;
}

async function session(lane: string, home: string, requests: Array<{ id: number; method: string; params?: Record<string, unknown> }>): Promise<{ responses: RpcResponse[]; stderr: string }> {
  const proc = Bun.spawn([process.execPath, CLI, "mcp", "--transport", "stdio", "--lane", lane], {
    env: { ...process.env, RADAR_HOME: home, RADAR_DB_PATH: join(home, "radar.db"), RADAR_FIXTURE_DIR: join(import.meta.dir, "../fixtures") },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const send = (obj: unknown) => proc.stdin.write(JSON.stringify(obj) + "\n");
  send({ jsonrpc: "2.0", id: 9001, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e-test", version: "0.0.1" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  for (const r of requests) send({ jsonrpc: "2.0", ...r });
  await new Promise((r) => setTimeout(r, 900));
  proc.stdin.end();
  const out = (await new Response(proc.stdout).text()).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as RpcResponse);
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  return { responses: out.filter((r) => r.id !== 9001), stderr };
}

function byId(responses: RpcResponse[], id: number): RpcResponse | undefined {
  return responses.find((r) => r.id === id);
}

function seededHome(): string {
  const home = mkdtempSync(join(tmpdir(), "radar-mcp-"));
  // Build fixture data + a profile through the real CLI.
  for (const args of [
    ["profile", "create", "--name", "mcp", "--topic", "revenge:90", "--hook", "identity_reversal:80"],
    ["run"],
  ]) {
    const proc = Bun.spawnSync([process.execPath, CLI, ...args], {
      env: { ...process.env, RADAR_HOME: home, RADAR_DB_PATH: join(home, "radar.db"), RADAR_FIXTURE_DIR: join(import.meta.dir, "../fixtures") },
    });
    if (proc.exitCode !== 0) throw new Error(`seed failed: ${proc.stderr.toString()}`);
  }
  return home;
}

describe("MCP stdio e2e", () => {
  test("initialize + tools/list + search call over the real transport", async () => {
    const home = seededHome();
    const { responses, stderr } = await session("reader", home, [
      { id: 1, method: "tools/list" },
      { id: 2, method: "tools/call", params: { name: "radar.search", arguments: { view: "opportunities", limit: 5 } } },
    ]);
    const tools = byId(responses, 1)?.result?.tools!;
    expect(tools.map((t) => t.name).sort()).toEqual(["radar.execute", "radar.search"]);
    // Reader lane: execute is advertised but with zero allowed actions.
    const exec = tools.find((t) => t.name === "radar.execute")!;
    expect(exec.description).toContain("none");
    expect(exec.description).not.toContain("feedback_add");

    const search = byId(responses, 2)?.result;
    expect(search?.isError).toBe(false);
    const rows = JSON.parse(search!.content![0]!.text) as unknown[];
    expect(rows.length).toBeGreaterThan(0);

    // stdout stays pure JSON-RPC; diagnostics only on stderr.
    expect(stderr).toContain("[radar-mcp]");
  });

  test("reader write attempts are denied with the same shape as unknown actions", async () => {
    const home = seededHome();
    const { responses } = await session("reader", home, [
      { id: 1, method: "tools/call", params: { name: "radar.execute", arguments: { action: "feedback_add", input: { opportunity_ref: "opp-x", kind: "saved" } } } },
      { id: 2, method: "tools/call", params: { name: "radar.execute", arguments: { action: "definitely_not_real", input: {} } } },
    ]);
    for (const id of [1, 2]) {
      const res = byId(responses, id)?.result;
      expect(res?.isError).toBe(true);
      expect(res!.content![0]!.text).toContain("not allowed for lane 'reader'");
    }
    // Denied attempts are audited with outcome=denied, args digest only.
    const audit = readFileSync(join(home, "mcp-audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit.filter((e) => e.outcome === "denied")).toHaveLength(2);
    for (const e of audit) {
      expect(e.args_digest).toMatch(/^sha256:/);
      expect(e.spec).toBe("radar.mcp.audit.v1");
      expect(JSON.stringify(e)).not.toMatch(/cookie|password|authorization/i);
    }
  });

  test("operator cannot discover or invoke external collection actions", async () => {
    const home = seededHome();
    const { responses } = await session("operator", home, [
      { id: 1, method: "tools/list" },
      { id: 2, method: "tools/call", params: { name: "radar.execute", arguments: { action: "collect", input: {} } } },
      { id: 3, method: "tools/call", params: { name: "radar.execute", arguments: { action: "daily_run", input: {} } } },
    ]);
    const execute = byId(responses, 1)?.result?.tools?.find((tool) => tool.name === "radar.execute") as unknown as { description: string; inputSchema: { properties: { action: { enum: string[] } } } };
    expect(execute.description).toContain("never available over MCP");
    expect(execute.inputSchema.properties.action.enum).not.toContain("collect");
    expect(execute.inputSchema.properties.action.enum).not.toContain("daily_run");
    for (const id of [2, 3]) {
      expect(byId(responses, id)?.result?.isError).toBe(true);
    }
  });

  test("curator can append feedback; audit records success before return", async () => {
    const home = seededHome();
    const search = await session("curator", home, [
      { id: 1, method: "tools/call", params: { name: "radar.search", arguments: { view: "opportunities", limit: 1 } } },
    ]);
    const ref = (JSON.parse(byId(search.responses, 1)!.result!.content![0]!.text) as Array<{ ref: string }>)[0]!.ref;
    const { responses } = await session("curator", home, [
      { id: 1, method: "tools/call", params: { name: "radar.execute", arguments: { action: "feedback_add", input: { opportunity_ref: ref, kind: "saved" } } } },
    ]);
    const res = byId(responses, 1)?.result;
    expect(res?.isError).toBe(false);
    const payload = JSON.parse(res!.content![0]!.text);
    expect(payload.status).toBe("success");
    const audit = readFileSync(join(home, "mcp-audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const fb = audit.find((e) => e.action === "feedback_add");
    expect(fb.outcome).toBe("success");
    expect(fb.lane).toBe("curator");
    // Idempotency: same key replays without a second append.
    const again = await session("curator", home, [
      { id: 1, method: "tools/call", params: { name: "radar.execute", arguments: { action: "feedback_add", input: { opportunity_ref: ref, kind: "saved" } } } },
    ]);
    const payload2 = JSON.parse(byId(again.responses, 1)!.result!.content![0]!.text);
    expect(payload2.facts.duplicate).toBe(true);
  });

  test("resources and prompt surfaces", async () => {
    const home = seededHome();
    const { responses } = await session("reader", home, [
      { id: 1, method: "resources/list" },
      { id: 2, method: "resources/read", params: { uri: "radar://capabilities" } },
      { id: 3, method: "resources/read", params: { uri: "radar://profile/active" } },
      { id: 4, method: "resources/read", params: { uri: "radar://editions/latest" } },
      { id: 5, method: "resources/read", params: { uri: "radar://runs" } },
      { id: 6, method: "resources/read", params: { uri: "radar://sources/status" } },
      { id: 8, method: "prompts/list" },
      { id: 9, method: "prompts/get", params: { name: "radar_personal_brief" } },
    ]);
    const uris = byId(responses, 1)?.result?.resources!.map((r) => r.uri);
    expect(uris).toContain("radar://capabilities");
    expect(uris).toContain("radar://editions/latest");

    const caps = JSON.parse(byId(responses, 2)!.result!.contents![0]!.text as string) as Array<{ capability: string; status: string }>;
    expect(caps.some((c) => c.capability === "remote_mcp_endpoint" && c.status === "unavailable")).toBe(true);

    const profile = JSON.parse(byId(responses, 3)!.result!.contents![0]!.text as string);
    expect(profile.ref).toBe("profile-mcp");

    const edition = JSON.parse(byId(responses, 4)!.result!.contents![0]!.text as string);
    expect(["ready", "empty", "degraded", "absent"]).toContain(edition.status ?? "absent");

    const runList = JSON.parse(byId(responses, 5)!.result!.contents![0]!.text as string);
    expect(runList.runs.length).toBeGreaterThan(0);

    // sources/status is reader-safe: local checks + latest collection receipt
    // only — live network/backend probing (firecrawl, xiaohongshu login) is
    // CLI-only via `radar doctor` and must not appear as live probe keys.
    const sources = JSON.parse(byId(responses, 6)!.result!.contents![0]!.text as string) as {
      checks: Record<string, { status: string }>;
      note: string;
    };
    expect(sources.note).toContain("radar doctor");
    expect(sources.checks["last-collection"]).toBeDefined();
    expect(sources.checks["firecrawl"]).toBeUndefined();
    expect(sources.checks["xhs-backend"]).toBeUndefined();

    const prompts = byId(responses, 8)?.result?.prompts!;
    expect(prompts.map((p) => p.name)).toEqual(["radar_personal_brief"]);
    const brief = (byId(responses, 9)?.result?.messages ?? []) as Array<{ role: string; content?: { type: string; text?: string } }>;
    expect(brief[0]!.content).toMatchObject({ type: "text" });
    expect(String(brief[0]!.content!.text)).toContain("never trigger collection");
  });

  test("reconnect does not auto-replay collect; run receipts enable reconcile", async () => {
    const home = seededHome();
    // Operator session 1: note the run count.
    const before = Bun.spawnSync([process.execPath, CLI, "runs", "--json"], {
      env: { ...process.env, RADAR_HOME: home, RADAR_DB_PATH: join(home, "radar.db") } });
    const runsBefore = JSON.parse(before.stdout.toString()).facts.runs;
    // Session dies (no calls), a fresh session connects and only reads.
    const { responses } = await session("operator", home, [
      { id: 1, method: "tools/call", params: { name: "radar.execute", arguments: { action: "score", input: {} } } },
    ]);
    expect(byId(responses, 1)?.result?.isError).toBe(false);
    const after = Bun.spawnSync([process.execPath, CLI, "runs", "--json"], {
      env: { ...process.env, RADAR_HOME: home, RADAR_DB_PATH: join(home, "radar.db") } });
    const runsAfter = JSON.parse(after.stdout.toString()).facts.runs;
    // Score was the ONLY new run: reconnect triggered no hidden collect.
    expect(runsAfter).toBe(runsBefore + 1);
  });

  test("audit tail is the CLI-only read surface", () => {
    const home = mkdtempSync(join(tmpdir(), "radar-audit-"));
    const proc = Bun.spawnSync([process.execPath, CLI, "audit", "tail", "--json"], {
      env: { ...process.env, RADAR_HOME: home, RADAR_DB_PATH: join(home, "radar.db") } });
    const env = JSON.parse(proc.stdout.toString());
    expect(env.command).toBe("radar.audit.tail");
    expect(env.status).toBe("success");
    expect(existsSync(join(home, "mcp-audit.jsonl"))).toBe(false); // empty ledger, no phantom rows
  });
});

  test("repeated edition_build is idempotent and audited as reuse", async () => {
    const home = seededHome();
    for (let i = 1; i <= 2; i++) {
      const { responses } = await session("operator", home, [
        { id: i, method: "tools/call", params: { name: "radar.execute", arguments: { action: "edition_build", input: { date: "2026-08-29" } } } },
      ]);
      expect(byId(responses, i)?.result?.isError).toBe(false);
    }
    const audit = readFileSync(join(home, "mcp-audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const builds = audit.filter((e) => e.action === "edition_build");
    expect(builds).toHaveLength(2);
    // First MCP build for the date is fresh (radar run built TODAY's edition,
    // not this fixture date); the second is a natural-key hit audited as
    // reuse with the same immutable ref.
    expect(builds[0]!.idempotent_reuse).toBeUndefined();
    expect(builds[1]!.idempotent_reuse).toBe(true);
    expect(builds[0]!.edition_ref).toBe(builds[1]!.edition_ref);
  });
