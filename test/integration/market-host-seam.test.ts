import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Real-subprocess stdio replay of the market host seam (radar-market-host-seam-v1):
// seed via CLI invocations in an isolated RADAR_HOME, then drive
// `market host-serve` frames end to end: initialize-backed reads, brief,
// coverage gaps, catch-up pagination, typed dispatch idempotency and the
// policy refusal path. Frames are the only stdout the process produces.

const FRAME = "radar.market.host.frame.v1";

function seedCli(env: Record<string, string>) {
  return (...args: string[]) => {
    const proc = Bun.spawnSync([process.execPath, "run", "src/cli.ts", ...args, "--json"], {
      cwd: process.cwd(),
      env,
    });
    if (proc.exitCode !== 0) throw new Error(`seed command failed: ${args.join(" ")} -> ${proc.stdout.toString()}${proc.stderr.toString()}`);
    return JSON.parse(proc.stdout.toString()) as { data?: Record<string, unknown>; error?: { code: string } };
  };
}

async function* readLines(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      yield buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
    }
  }
  if (buffer.length > 0) yield buffer;
}

test("market host-serve answers a full stdio frame journey with idempotent dispatch and policy refusal", async () => {
  const home = mkdtempSync(join(tmpdir(), "radar-host-seam-"));
  const env = { ...process.env, RADAR_HOME: home, RADAR_DB_PATH: join(home, "radar.db"), RADAR_CONFIG_PATH: join(home, "config.json") };
  const cli = seedCli(env);

  // Seed: market domain plus a personal edition for the dispatch leg.
  expect(cli("market", "init").data).toBeDefined();
  cli("market", "import-catalog", "--source", "dramabox", "--file", "test/fixtures/market/dramabox.md",
    "--format", "markdown", "--observed-at", "2026-09-10T08:00:00Z", "--fixture");
  cli("market", "import-catalog", "--source", "reelshort", "--file", "test/fixtures/market/reelshort.html",
    "--format", "html", "--observed-at", "2026-09-11T08:00:00Z", "--fixture");
  cli("market", "analyze", "--start", "2026-09-10T00:00:00Z", "--end", "2026-09-12T00:00:00Z");
  cli("market", "brief", "build", "--start", "2026-09-10T00:00:00Z", "--end", "2026-09-12T00:00:00Z");
  cli("profile", "create", "--name", "main", "--minimum-fit", "0", "--minimum-confidence", "0");
  const runEnv = { ...env, RADAR_FIXTURE_DIR: "test/fixtures" };
  const run = Bun.spawnSync([process.execPath, "run", "src/cli.ts", "run", "--json"], { cwd: process.cwd(), env: runEnv });
  expect(run.exitCode).toBe(0);

  const proc = Bun.spawn([process.execPath, "run", "src/cli.ts", "market", "host-serve"], {
    cwd: process.cwd(),
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const iterator = readLines(proc.stdout)[Symbol.asyncIterator]();
  const send = async (raw: string) => {
    proc.stdin!.write(raw + "\n");
    await proc.stdin!.flush();
    const { value } = await iterator.next();
    return JSON.parse(value!) as Record<string, unknown>;
  };
  const readFrame = (id: number, uri: string) => send(JSON.stringify({ schema: FRAME, id, op: "read", uri }));
  const payload = (frame: Record<string, unknown>) => JSON.parse((frame.resource as { text: string }).text) as Record<string, unknown>;

  try {
    // 1. Capability probe shape the DSH client trusts.
    const capabilities = payload(await readFrame(1, "radar://market/capabilities"));
    expect(capabilities.spec).toBe("radar.market_capabilities.v1");
    expect(capabilities.views).toContain("market_brief");
    expect(capabilities.views).toContain("market_reader");

    // 2. Reader state.
    const reader = payload(await readFrame(2, "radar://market/reader"));
    expect(reader.reader_ref).toBe("local");
    expect(reader.policy_revision).toEqual(expect.any(String));

    // 3. Latest brief with honest status.
    const brief = payload(await readFrame(3, "radar://market/briefs/latest"));
    expect(brief.spec).toBe("radar.market_brief.v1");
    expect(["ready", "empty", "degraded"]).toContain(brief.status as string);

    // 4. Coverage gaps.
    const coverage = payload(await readFrame(4, "radar://market/coverage"));
    expect(coverage.spec).toBe("radar.market_source_gaps.v1");

    // 5. Catch-up pagination over the owner cursor: distinct pages, bounded end.
    const page1 = payload(await readFrame(5, "radar://market/catchup?limit=1"));
    expect(page1.spec).toBe("radar.market_catchup.v1");
    const page1Signals = page1.signals as Record<string, unknown>[];
    expect(page1Signals).toHaveLength(1);
    const firstSignal = page1Signals[0]!;
    const seen = new Set([firstSignal.signal_ref as string]);
    let frameId = 6;
    let cursor = page1.next_cursor as string | null;
    while (cursor !== null && frameId < 16) {
      const page = payload(await readFrame(frameId, `radar://market/catchup?cursor=${cursor}&limit=1`));
      expect(page.spec).toBe("radar.market_catchup.v1");
      for (const row of page.signals as Record<string, unknown>[]) {
        expect(seen.has(row.signal_ref as string)).toBe(false);
        seen.add(row.signal_ref as string);
      }
      cursor = page.next_cursor as string | null;
      frameId++;
    }
    expect(cursor).toBeNull();
    expect(seen.size).toBeGreaterThanOrEqual(2);

    // 6. Signal revision detail bound to the exact revision.
    const signalUri = `radar://market/signals/${firstSignal.signal_ref}/revisions/${firstSignal.revision}`;
    const signal = payload(await readFrame(20, signalUri));
    expect(signal.signal_ref).toBe(firstSignal.signal_ref);

    // 7. Typed proposal dispatch -> assignment receipt, idempotent replay.
    const intent = { schema: "dsh.radar.intent.v1", kind: "proposal", opportunityRefs: [], idempotencyKey: "dsh-integration-1", confirmed: false };
    const dispatch = await send(JSON.stringify({ schema: FRAME, id: 21, op: "dispatch", intent }));
    const receipt = dispatch.receipt as Record<string, unknown>;
    expect(receipt.outcome).toBe("submitted");
    expect(receipt.assignmentRef).toEqual(expect.any(String));
    const replay = await send(JSON.stringify({ schema: FRAME, id: 22, op: "dispatch", intent }));
    expect(replay.receipt).toEqual(receipt);
    const lookup = await send(JSON.stringify({ schema: FRAME, id: 23, op: "lookup-receipt", idempotencyKey: "dsh-integration-1" }));
    expect((lookup.receipt as Record<string, unknown>).outcome).toBe("reconciled");

    // 8. Malformed line answers frame_invalid and never kills the loop.
    const malformed = await send("not a frame");
    expect(malformed).toMatchObject({ id: null, ok: false, error: { code: "frame_invalid" } });
    const afterMalformed = await readFrame(24, "radar://market/reader");
    expect(afterMalformed.ok).toBe(true);

    // 9. Policy refusal: block the signal's topic, re-read must refuse.
    const topics = (signal.topics as string[] | undefined) ?? [];
    const topic = topics[0] ?? "taboo";
    cli("market", "config", "set", "--revision", "1", "--blocked-topic", topic);
    const blocked = await readFrame(25, signalUri);
    expect((blocked.error as { code: string }).code).toBe("content_blocked");

    // 10. Shutdown frame ends the process cleanly.
    const shutdown = await send(JSON.stringify({ schema: FRAME, id: 26, op: "shutdown" }));
    expect(shutdown).toMatchObject({ id: 26, ok: true, stopped: true });
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
  } finally {
    // Ensure the subprocess cannot leak past a failed assertion.
    try { proc.stdin?.end(); } catch { /* already closed */ }
    await proc.exited.catch(() => undefined);
  }
}, 120_000);
