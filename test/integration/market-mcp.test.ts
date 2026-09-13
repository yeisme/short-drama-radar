import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { openDb } from "../../src/db/client.ts";
import { initializeMarket } from "../../src/market/sources.ts";
import { importCatalog } from "../../src/market/catalog.ts";
import { analyzeMarket, signalByRef, correctSignal } from "../../src/market/signals.ts";
import { buildMarketBrief } from "../../src/market/brief.ts";
import { buildMarketReview } from "../../src/market/review.ts";
import { readReader, isRead } from "../../src/market/reader.ts";
import { recordQualification } from "../../src/market/qualification.ts";

test("market MCP discovery, historical resources and bounded question work through real stdio without writes", async () => {
  const home = mkdtempSync(join(tmpdir(), "radar-market-mcp-"));
  const db = openDb(join(home, "radar.db"));
  const client = new Client({ name: "market-reader-test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [join(import.meta.dir, "../../src/cli.ts"), "mcp", "--transport", "stdio", "--lane", "reader"],
    env: { RADAR_HOME: home, RADAR_DB_PATH: join(home, "radar.db") }, stderr: "pipe" });
  try {
    initializeMarket(db);
    const qualification = recordQualification(db, "dramabox", 1).record;
    await importCatalog(db, { source: "dramabox", content: readFileSync("test/fixtures/market/dramabox.md", "utf8"),
      format: "markdown", observedAt: "2026-09-10T08:00:00Z", origin: "fixture" });
    const analysis = analyzeMarket(db, "2026-09-10T00:00:00Z", "2026-09-11T00:00:00Z");
    const signal = signalByRef(db, analysis.signals[0].ref)!;
    buildMarketBrief(db, "2026-09-10T00:00:00Z", "2026-09-11T00:00:00Z", new Date("2026-09-11T08:00:00Z"));
    correctSignal(db, { ref: signal.signal_ref, expected_revision: 1, evidence_refs: signal.evidence_refs,
      corrected_at: "2026-09-11T08:00:00Z", outcome: "retracted", reason: "Fixture correction." });
    const reader = readReader(db);
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(["radar.execute", "radar.search"]);
    const schema = tools.find(t => t.name === "radar.search")!.inputSchema;
    expect(JSON.stringify(schema)).toContain("market_compare");
    expect(JSON.stringify(schema)).toContain("left_revision");
    const resources = await client.listResources();
    expect(resources.resources.some(r => r.uri === "radar://market/capabilities")).toBe(true);
    expect(resources.resources.some(r => r.uri === "radar://editions/latest")).toBe(true);
    const templates = await client.listResourceTemplates();
    expect(templates.resourceTemplates.some(r => r.uriTemplate.includes("signals/{ref}/revisions/{revision}"))).toBe(true);
    const read = async (uri: string) => {
      const content = (await client.readResource({ uri })).contents[0];
      if (!("text" in content)) throw new Error("Expected a text resource");
      return JSON.parse(content.text);
    };
    expect((await read("radar://market/capabilities")).recovery.execution_host).toBe("Radar owner host");
    const toolCapabilities = await client.callTool({ name: 'radar.search', arguments: { view: 'market_capabilities' } });
    expect(JSON.parse((toolCapabilities.content as Array<{ text: string }>)[0].text).views).toContain('market_brief');
    expect(await read("radar://market/qualifications/" + qualification.record_ref)).toEqual(qualification);
    expect((await read("radar://market/briefs/latest")).status).toBe("degraded");
    expect((await read('radar://market/catchup')).spec).toBe('radar.market_catchup.v1');
    expect((await read(`radar://market/signals/${signal.signal_ref}/revisions/1`)).lifecycle).toBe("active");
    expect((await read(`radar://market/signals/${signal.signal_ref}/revisions/2`)).lifecycle).toBe("retracted");
    await expect(read(`radar://market/signals/${signal.signal_ref}/revisions/99`)).rejects.toThrow();
    await expect(read('radar://market/briefs/missing')).rejects.toMatchObject({ data: { code: 'brief_not_found' } });
    const question = await client.callTool({ name: "radar.search", arguments: {
      view: "market_question", signal: signal.signal_ref, revision: 1, question: "What is supported?" } });
    expect(question.isError).toBe(false);
    const context = JSON.parse((question.content as Array<{ text: string }>)[0].text);
    expect(context.signal_revision).toBe(1);
    expect(context.evidence.length).toBeGreaterThan(0);
    const invalid = await client.callTool({ name: "radar.search", arguments: {
      view: "market_signal", signal: signal.signal_ref, revision: "1" } });
    expect(invalid.isError).toBe(true);
    const denied = await client.callTool({ name: "radar.execute", arguments: {
      action: "market_reader_mark", input: { signal: signal.signal_ref } } });
    expect(denied.isError).toBe(true);
    const prompt = await client.getPrompt({ name: "radar_market_brief" });
    expect(JSON.stringify(prompt)).toContain("no local CLI");
    expect(readReader(db)).toEqual(reader);
    const audit = readFileSync(join(home, "mcp-audit.jsonl"), "utf8");
    expect(audit).not.toContain("What is supported?");
    expect(audit).toContain('"outcome":"denied"');
  } finally {
    await client.close();
    db.$client.close();
    rmSync(home, { recursive: true, force: true });
  }
}, 15000);

test("curator mutations reconcile original keys and operator discovery excludes collection", async () => {
  const home = mkdtempSync(join(tmpdir(), "radar-market-mutation-"));
  const db = openDb(join(home, "radar.db"));
  const clients: Client[] = [];
  const connect = async (lane: string) => {
    const client = new Client({ name: "market-mutation-test", version: "1" });
    clients.push(client);
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [join(import.meta.dir, "../../src/cli.ts"), "mcp", "--transport", "stdio", "--lane", lane],
      env: { RADAR_HOME: home, RADAR_DB_PATH: join(home, "radar.db") }, stderr: "pipe" }));
    return client;
  };
  const execute = async (client: Client, action: string, input: unknown) => {
    const result = await client.callTool({ name: "radar.execute", arguments: { action, input } });
    return { failed: result.isError, data: JSON.parse((result.content as Array<{ text: string }>)[0].text) };
  };
  try {
    initializeMarket(db);
    await importCatalog(db, { source: "dramabox", content: readFileSync("test/fixtures/market/dramabox.md", "utf8"),
      format: "markdown", observedAt: "2026-09-10T08:00:00Z", origin: "fixture" });
    const signal = analyzeMarket(db, "2026-09-10T00:00:00Z", "2026-09-11T00:00:00Z").signals[0];
    const curator = await connect("curator");
    const schema = (await curator.listTools()).tools.find(t => t.name === "radar.execute")!.inputSchema;
    expect(JSON.stringify(schema)).toContain("market_reader_mark");
    expect(JSON.stringify(schema)).not.toContain("market_analyze");
    const reader = readReader(db);
    const payload = { key: "read-once", revision: reader.revision, policy_revision: reader.policy_revision, signals: [signal] };
    const marked = await execute(curator, "market_reader_mark", payload);
    expect(marked.failed).toBe(false);
    expect(isRead(db, signal)).toBe(true);
    expect(await execute(curator, "market_reader_mark", payload)).toEqual(marked);
    expect(readReader(db).revision).toBe(reader.revision + 1);
    expect((await execute(curator, "market_reader_unread", payload)).data.error).toBe("idempotency_conflict");
    expect((await execute(curator, "market_reader_unread", { ...payload, key: "stale-key" })).data.error).toBe("state_conflict");
    const reconnected = await connect("curator");
    const receipt = await reconnected.callTool({ name: "radar.search", arguments: { view: "market_reader_receipt", key: "read-once" } });
    expect(JSON.parse((receipt.content as Array<{ text: string }>)[0].text)).toEqual(marked.data);
    const current = () => ({ revision: readReader(db).revision, policy_revision: readReader(db).policy_revision });
    const added = await execute(reconnected, "market_watch_add", { ...current(), key: "watch-add", kind: "platform", target: "hongguo" });
    expect(added.failed).toBe(false);
    for (const [action, state] of [["pause", "paused"], ["resume", "active"], ["remove", "removed"]]) {
      const result = await execute(reconnected, "market_watch_" + action,
        { ...current(), key: "watch-" + action, watch: added.data.watch.watch_ref });
      expect(result.failed).toBe(false);
      expect(result.data.watch.state).toBe(state);
    }
    const operator = await connect("operator");
    const operatorSchema = JSON.stringify((await operator.listTools()).tools.find(t => t.name === "radar.execute")!.inputSchema);
    expect(operatorSchema).toContain("market_analyze");
    expect(operatorSchema).not.toContain("market_observe");
    expect((await execute(operator, "market_observe", {})).data.error).toBe("action_denied");
    const built = await execute(operator, "market_brief_build", { start: "2026-09-10T00:00:00Z", end: "2026-09-11T00:00:00Z" });
    expect(built.failed).toBe(false);
    expect(built.data.status).toBe("degraded");
    expect((await execute(operator, "market_brief_build", { start: "2026-09-10T00:00:00Z", end: "2026-09-11T00:00:00Z" })).data.reused).toBe(true);
  } finally {
    for (const client of clients) await client.close();
    db.$client.close();
    rmSync(home, { recursive: true, force: true });
  }
}, 15000);

test("CLI-less clients discover bounded list views; lane separation and old surfaces hold (S18/S19)", async () => {
  const home = mkdtempSync(join(tmpdir(), "radar-market-lists-"));
  const db = openDb(join(home, "radar.db"));
  let client: Client | undefined;
  try {
    initializeMarket(db);
    await importCatalog(db, { source: "dramabox", content: readFileSync("test/fixtures/market/dramabox.md", "utf8"),
      format: "markdown", observedAt: "2026-09-10T08:00:00Z", origin: "fixture" });
    const signal = analyzeMarket(db, "2026-09-10T00:00:00Z", "2026-09-11T00:00:00Z").signals[0];
    buildMarketBrief(db, "2026-09-10T00:00:00Z", "2026-09-11T00:00:00Z", new Date("2026-09-11T09:00:00Z"));
    buildMarketReview(db, "2026-09-10T00:00:00Z", "2026-09-11T00:00:00Z", "2026-09-12T09:00:00Z", new Date("2026-09-12T10:00:00Z"));
    client = new Client({ name: "market-list-test", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [join(import.meta.dir, "../../src/cli.ts"), "mcp", "--transport", "stdio", "--lane", "reader"],
      env: { RADAR_HOME: home, RADAR_DB_PATH: join(home, "radar.db") }, stderr: "pipe" }));
    const search = (await client.listTools()).tools.find(t => t.name === "radar.search")!.inputSchema;
    const schema = JSON.stringify(search);
    // New bounded list views are discoverable from tools/list only.
    for (const view of ["market_briefs", "market_signals", "market_reviews", "market_evidence_list"]) {
      expect(schema).toContain(view);
    }
    // Existing bound views keep their names (no rename, no removal).
    for (const view of ["market_brief", "market_signal", "market_evidence", "market_capabilities", "market_catchup"]) {
      expect(schema).toContain('"' + view + '"');
    }
    const resources = await client.listResources();
    for (const uri of ["radar://market/briefs", "radar://market/signals", "radar://market/reviews"]) {
      expect(resources.resources.some(r => r.uri === uri)).toBe(true);
    }
    const read = async (uri: string) => JSON.parse((await client!.readResource({ uri }) as unknown as { contents: Array<{ text: string }> }).contents[0].text);
    const briefs = await read("radar://market/briefs");
    expect(briefs.spec).toBe("radar.market_briefs.v1");
    expect(briefs.briefs[0].window).toEqual({ start: "2026-09-10T00:00:00.000Z", end: "2026-09-11T00:00:00.000Z" });
    const signals = await read("radar://market/signals");
    expect(signals.signals.some((s: { signal_ref: string }) => s.signal_ref === signal.ref)).toBe(true);
    const reviews = await read("radar://market/reviews");
    expect(reviews.reviews[0].entries).toBeGreaterThan(0);
    const search2 = async (args: Record<string, unknown>) => {
      const tool = await client!.callTool({ name: "radar.search", arguments: args });
      return JSON.parse((tool.content as Array<{ text: string }>)[0].text);
    };
    const evidence = await search2({ view: "market_evidence_list", signal: signal.ref, revision: 1 });
    expect(evidence.evidence.length).toBeGreaterThan(0);
    // Unknown view stays a named error, not a schema guess.
    const bad = await client.callTool({ name: "radar.search", arguments: { view: "market_nonexistent" } });
    expect(bad.isError).toBe(true);
    expect((bad.content as Array<{ text: string }>)[0].text).toContain("view_invalid");
    // Lane separation: the reader lane never gains operator mutations.
    const executeSchema = JSON.stringify((await client.listTools()).tools.find(t => t.name === "radar.execute")!.inputSchema);
    expect(executeSchema).not.toContain("market_analyze");
    expect(executeSchema).not.toContain("market_brief_build");
    const denied = await client.callTool({ name: "radar.execute", arguments: { action: "market_analyze", input: {} } });
    expect(denied.isError).toBe(true);
  } finally {
    if (client) await client.close();
    db.$client.close();
    rmSync(home, { recursive: true, force: true });
  }
}, 15000);
