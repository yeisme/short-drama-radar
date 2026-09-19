import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { openDb } from "../../src/db/client.ts";
import { initializeMarket, updateSettings } from "../../src/market/sources.ts";
import { importCatalog } from "../../src/market/catalog.ts";
import { analyzeMarket } from "../../src/market/signals.ts";
import { buildMarketBrief } from "../../src/market/brief.ts";
import { marketSignals } from "../../src/db/schema.ts";
import { collect, defaultAdapters } from "../../src/pipeline/collect.ts";
import { scoreDay } from "../../src/pipeline/scoring.ts";
import { persistOpportunities } from "../../src/pipeline/opportunity.ts";
import { ProfileService } from "../../src/profile/service.ts";
import { buildEdition } from "../../src/pipeline/edition.ts";
import { marketHostServe, MARKET_HOST_FRAME_SPEC } from "../../src/market/host-serve.ts";

// Frame helper: feed raw stdin lines, collect raw stdout lines.
async function serve(db: ReturnType<typeof openDb>, lines: string[]): Promise<Record<string, unknown>[]> {
  const output: string[] = [];
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of String(chunk).split("\n")) if (line.length > 0) output.push(line);
      callback();
    },
  });
  // One chunk with real newlines: readline splits on \n, so bare array
  // elements would concatenate into a single malformed line.
  await marketHostServe(db, { input: Readable.from([lines.join("\n") + "\n"]), output: sink });
  return output.map((line) => JSON.parse(line) as Record<string, unknown>);
}

const frame = (id: number, op: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ schema: MARKET_HOST_FRAME_SPEC, id, op, ...extra });

const payload = (response: Record<string, unknown>) =>
  JSON.parse((response.resource as { text: string }).text) as Record<string, unknown>;

async function marketSeed(db: ReturnType<typeof openDb>) {
  initializeMarket(db);
  await importCatalog(db, { source: "dramabox", content: readFileSync("test/fixtures/market/dramabox.md", "utf8"),
    format: "markdown", observedAt: "2026-09-10T08:00:00Z", origin: "fixture" });
  await importCatalog(db, { source: "reelshort", content: readFileSync("test/fixtures/market/reelshort.html", "utf8"),
    format: "html", observedAt: "2026-09-11T08:00:00Z", origin: "fixture" });
  analyzeMarket(db, "2026-09-10T00:00:00Z", "2026-09-12T00:00:00Z");
  buildMarketBrief(db, "2026-09-10T00:00:00Z", "2026-09-12T00:00:00Z", new Date("2026-09-12T09:00:00Z"));
}

test("host seam frames route reads to market services with named errors and honest states", async () => {
  const db = openDb(":memory:");
  try {
    await marketSeed(db);
    const responses = await serve(db, [
      "not-json",
      frame(1, "read", { uri: "radar://market/capabilities" }),
      frame(2, "read", { uri: "radar://market/reader" }),
      frame(3, "read", { uri: "radar://market/briefs/latest" }),
      frame(4, "read", { uri: "radar://market/briefs/brief-missing" }),
      frame(5, "read", { uri: "radar://market/coverage" }),
      frame(6, "read", { uri: "radar://market/watches" }),
      frame(7, "read", { uri: "radar://market/reviews" }),
      frame(8, "read", { uri: "radar://market/signals/sig-missing/revisions/1" }),
      frame(9, "read", { uri: "radar://market/catchup?limit=1" }),
      frame(10, "read", { uri: "radar://market/../../../etc/passwd" }),
      frame(11, "read", { uri: "radar://market/unknown-resource" }),
      frame(12, "frobnicate"),
      frame(13, "shutdown"),
    ]);
    expect(responses).toHaveLength(14);
    // Malformed line: id null, loop continues.
    expect(responses[0]).toMatchObject({ id: null, ok: false, error: { code: "frame_invalid" } });
    const capabilities = payload(responses[1]!);
    expect(capabilities.spec).toBe("radar.market_capabilities.v1");
    expect(capabilities.views).toContain("market_brief");
    expect(capabilities.views).toContain("market_reader");
    expect(payload(responses[2]!).reader_ref).toBe("local");
    const brief = payload(responses[3]!);
    expect(brief.spec).toBe("radar.market_brief.v1");
    expect(["ready", "empty", "degraded"]).toContain(brief.status as string);
    expect((responses[4]!.error as { code: string }).code).toBe("brief_not_found");
    expect(payload(responses[5]!).spec).toBe("radar.market_source_gaps.v1");
    expect(Array.isArray(payload(responses[6]!).watches)).toBe(true);
    expect(payload(responses[7]!).spec).toBe("radar.market_reviews.v1");
    expect((responses[8]!.error as { code: string }).code).toBe("signal_not_found");
    // Catch-up pagination: bounded page with an owner cursor.
    const page = payload(responses[9]!);
    expect(page.spec).toBe("radar.market_catchup.v1");
    const signals = page.signals as Record<string, unknown>[];
    expect(Array.isArray(signals)).toBe(true);
    const nextCursor = page.next_cursor as string | null;
    if (signals.length > 0 && nextCursor !== null) {
      const next = await serve(db, [frame(14, "read", { uri: `radar://market/catchup?cursor=${nextCursor}&limit=1` })]);
      expect(payload(next[0]!).spec).toBe("radar.market_catchup.v1");
    }
    expect((responses[10]!.error as { code: string }).code).toBe("resource_not_found");
    expect((responses[11]!.error as { code: string }).code).toBe("resource_not_found");
    expect((responses[12]!.error as { code: string }).code).toBe("frame_invalid");
    expect(responses[13]).toMatchObject({ id: 13, ok: true, stopped: true });
  } finally {
    db.$client.close();
  }
});

test("host seam dispatch maps typed proposals to idempotent assignment receipts", async () => {
  const db = openDb(":memory:");
  try {
    await marketSeed(db);
    await collect(db, defaultAdapters(), { firecrawlBaseUrl: "unused", agentReachBin: "unused", timeoutMs: 5_000, fixtureDir: "test/fixtures" }, new Date("2026-08-29T08:59:00Z"));
    scoreDay(db, "2026-08-29");
    persistOpportunities(db, "2026-08-29");
    const profiles = new ProfileService(db);
    const profile = profiles.create("host-seam", { minimum_fit: 0, minimum_confidence: 0 });
    const { edition } = buildEdition(db, profile, "2026-08-29");
    const opportunityRef = edition.entries[0]!.opportunityRef;
    const otherRef = edition.entries[1]!.opportunityRef;
    const intent = (idempotencyKey: string, refs: string[]) => JSON.stringify({
      schema: "dsh.radar.intent.v1", kind: "proposal", opportunityRefs: refs, idempotencyKey, confirmed: false,
    });
    const responses = await serve(db, [
      frame(1, "dispatch", { intent: JSON.parse(intent("dsh-key-1", [opportunityRef])) }),
      frame(2, "dispatch", { intent: JSON.parse(intent("dsh-key-1", [opportunityRef])) }),
      frame(3, "dispatch", { intent: JSON.parse(intent("dsh-key-1", [otherRef])) }),
      frame(4, "dispatch", { intent: { schema: "dsh.radar.intent.v1", kind: "refresh", opportunityRefs: [], idempotencyKey: "k", confirmed: true } }),
      frame(5, "dispatch", { intent: { schema: "other.v1", kind: "proposal", opportunityRefs: [], idempotencyKey: "k2", confirmed: false } }),
      frame(6, "dispatch", { intent: { schema: "dsh.radar.intent.v1", kind: "proposal", opportunityRefs: ["https://evil.example/x"], idempotencyKey: "k3", confirmed: false } }),
      frame(7, "lookup-receipt", { idempotencyKey: "dsh-key-1" }),
      frame(8, "lookup-receipt", { idempotencyKey: "never-existed" }),
    ]);
    const first = responses[0]!.receipt as Record<string, unknown>;
    expect(first.outcome).toBe("submitted");
    expect(first.assignmentRef).toEqual(expect.any(String));
    // Idempotent replay returns the original receipt.
    expect(responses[1]!.receipt).toEqual(first);
    // A different payload under the same key conflicts.
    expect((responses[2]!.error as { code: string }).code).toBe("idempotency_conflict");
    expect((responses[3]!.error as { code: string }).code).toBe("intent_unsupported");
    expect((responses[4]!.error as { code: string }).code).toBe("intent_invalid");
    expect((responses[5]!.error as { code: string }).code).toBe("intent_invalid");
    const reconciled = responses[6]!.receipt as Record<string, unknown>;
    expect(reconciled.outcome).toBe("reconciled");
    expect(reconciled.assignmentRef).toBe(first.assignmentRef);
    expect(responses[7]!.receipt).toBeNull();
  } finally {
    db.$client.close();
  }
});

test("host seam dispatch reports honest do_not_shoot and refuses without a profile", async () => {
  const db = openDb(":memory:");
  try {
    await marketSeed(db);
    const emptyEdition = { schema: "dsh.radar.intent.v1", kind: "proposal", opportunityRefs: [], idempotencyKey: "empty-1", confirmed: false };
    const before = await serve(db, [frame(1, "dispatch", { intent: emptyEdition })]);
    expect((before[0]!.error as { code: string }).code).toBe("profile_required");
    const profiles = new ProfileService(db);
    const strict = profiles.create("never-shoot", { minimum_fit: 100, minimum_confidence: 100 });
    const { edition } = buildEdition(db, strict, "2026-09-15");
    expect(edition.status).toBe("empty");
    const responses = await serve(db, [frame(2, "dispatch", { intent: emptyEdition })]);
    const receipt = responses[0]!.receipt as Record<string, unknown>;
    expect(receipt.outcome).toBe("rejected");
    expect(receipt.reason).toMatch(/do_not_shoot/);
    const again = await serve(db, [frame(3, "lookup-receipt", { idempotencyKey: "empty-1" })]);
    expect((again[0]!.receipt as Record<string, unknown>).outcome).toBe("reconciled");
  } finally {
    db.$client.close();
  }
});

test("host seam keeps blocked topics enforced on every read exit", async () => {
  const db = openDb(":memory:");
  try {
    await marketSeed(db);
    const signal = db.select().from(marketSignals).all()[0]!;
    const topic = signal.payload.topics[0] ?? "taboo";
    updateSettings(db, 1, { blocked_topics: [topic] });
    const question = encodeURIComponent("Why did this change?");
    const responses = await serve(db, [
      frame(1, "read", { uri: `radar://market/signals/${signal.payload.signal_ref}/revisions/${signal.payload.revision}` }),
      frame(2, "read", { uri: `radar://market/question?signal=${signal.payload.signal_ref}&revision=${signal.payload.revision}&question=${question}` }),
      frame(3, "read", { uri: "radar://market/briefs/latest" }),
    ]);
    expect((responses[0]!.error as { code: string }).code).toBe("content_blocked");
    expect((responses[1]!.error as { code: string }).code).toBe("content_blocked");
    // Blocked content is never echoed back in the error frame.
    expect(JSON.stringify(responses[0])).not.toContain(signal.payload.title);
    const brief = payload(responses[2]!);
    expect(brief.spec).toBe("radar.market_brief.v1");
  } finally {
    db.$client.close();
  }
});
