import { expect, test } from "bun:test";
import { openDb } from "../../src/db/client.ts";
import { marketCommand } from "../../src/market/cli.ts";
import { renderAgentLine, renderExplain, renderJsonEnvelope, validateEnvelope } from "../../src/output/envelope.ts";
import { EventWriter } from "../../src/output/events.ts";
import { MarketStoreError } from "../../src/market/repository.ts";

// Task 4.2: every market projection renders through the standard contract —
// summary/json/agent/events/explain from one CommandResult, named errors,
// streams that always end with end|error, and no secrets in any surface.

function flags(entries: Record<string, string[]> = {}): Map<string, string[]> {
  return new Map(Object.entries(entries));
}

test("one market result renders as json, agent and explain without contract drift", async () => {
  const db = openDb(":memory:");
  try {
    await marketCommand(["market", "init"], flags(), db);
    const result = await marketCommand(["market", "source", "list"], flags(), db);
    // JSON envelope validates against the standard surface.
    const envelope = renderJsonEnvelope(result);
    const validation = validateEnvelope(envelope);
    expect(validation.problems).toEqual([]);
    expect(envelope.command).toBe("radar.market.source.list");
    // Agent lines are stable key=value with a data ref, never a raw payload.
    const agent = renderAgentLine(result);
    expect(agent.split("\n")[0]).toBe("spec_version=1.0");
    expect(agent).toContain("mode=agent");
    expect(agent).toContain("command=radar.market.source.list");
    expect(agent).toContain("data_ref=radar-data-");
    expect(agent).not.toContain("sampling_scope");
    // Explain reports carry the English decision markers.
    const explain = renderExplain(result);
    expect(explain).toContain("Conclusion: ");
    expect(explain).toContain("Evidence: ");
    expect(explain).toContain("Recommended next step: ");
    // A result without evidence is labeled a hypothesis, not a fact.
    const bare = renderExplain({ command: "radar.market.noop", status: "success", summary: "Nothing recorded.", exitCode: 0 });
    expect(bare).toContain("hypothesis, not a verified fact");
  } finally { db.$client.close(); }
});

test("failed projections keep named errors and redacted messages on every surface", async () => {
  const db = openDb(":memory:");
  try {
    await marketCommand(["market", "init"], flags(), db);
    const failed = await marketCommand(["market", "brief", "show"], flags({ brief: ["nope"] }), db)
      .then(() => { throw new Error("expected failure"); }, (error: MarketStoreError) => error);
    expect(failed.code).toBe("brief_not_found");
    for (const rendered of [
      renderAgentLine({ command: "radar.market.brief.show", status: "failed", summary: "failed", error: { code: failed.code, message: failed.message }, exitCode: 1 }),
      renderExplain({ command: "radar.market.brief.show", status: "failed", summary: "failed", error: { code: failed.code, message: failed.message }, exitCode: 1 }),
    ]) {
      expect(rendered).toContain("brief_not_found");
      // Secrets never appear on any output surface.
      for (const secret of ["cookie", "password", "token", "super-secret-value"]) {
        expect(rendered.toLowerCase()).not.toContain(secret.toLowerCase());
      }
    }
    // A secret-looking flag value is not echoed back by input errors.
    const invalid = await marketCommand(["market", "import-catalog"], flags({
      source: ["hongguo"], file: ["/tmp/does-not-exist.md"], format: ["markdown"],
      "observed-at": ["2026-09-12T08:00:00Z"], secret: ["super-secret-value"],
    }), db).then(() => { throw new Error("expected failure"); }, (error: MarketStoreError) => error);
    expect(invalid.code).toBe("flag_invalid");
    expect(invalid.message).not.toContain("super-secret-value");
  } finally { db.$client.close(); }
});

test("market streams carry staged phases and terminate with end or error", async () => {
  const db = openDb(":memory:");
  try {
    await marketCommand(["market", "init"], flags(), db);
    // Success stream: start -> phase -> end, seq strictly increasing.
    const lines: string[] = [];
    const writer = new EventWriter("market-test-run", line => lines.push(line));
    await marketCommand(["market", "brief", "build"], flags({ start: ["2026-09-12T00:00:00Z"], end: ["2026-09-13T00:00:00Z"] }), db, writer);
    const events = lines.map(l => JSON.parse(l) as { seq: number; run_id: string; event: string; phase?: string });
    expect(events[0]!.event).toBe("start");
    expect(events.some(e => e.event === "phase" && e.phase === "brief_frozen")).toBe(true);
    expect(events.at(-1)!.event).toBe("end");
    expect(events.map(e => e.seq)).toEqual([...events.keys()].map(i => i + 1));
    expect(events.every(e => e.run_id === "market-test-run")).toBe(true);
    // Failure mid-stream: the final line is an error event with a named code.
    const failureLines: string[] = [];
    const failureWriter = new EventWriter("market-test-fail", line => failureLines.push(line));
    await marketCommand(["market", "brief", "build"], flags({ start: ["2026-09-13T00:00:00Z"], end: ["2026-09-12T00:00:00Z"] }), db, failureWriter)
      .then(() => { throw new Error("expected window_invalid"); }, (error: MarketStoreError) => {
        // Same terminal handling as the CLI error path.
        failureWriter.error(error.code, error.message);
      });
    const failureEvents = failureLines.map(l => JSON.parse(l) as { seq: number; event: string; code?: string });
    expect(failureEvents.at(-1)!.event).toBe("error");
    expect(failureEvents.at(-1)!.code).toBe("window_invalid");
    expect(failureEvents.map(e => e.seq)).toEqual([...failureEvents.keys()].map(i => i + 1));
  } finally { db.$client.close(); }
});
