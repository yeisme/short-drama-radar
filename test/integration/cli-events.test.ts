import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventWriter } from "../../src/output/events.ts";

// --events failure contract: once a stream starts (or a command intends to),
// the LAST stdout line must be a well-formed error event and the process must
// exit non-zero — never a bare envelope and never a silent empty stream.

const CLI = join(import.meta.dir, "../../src/cli.ts");

describe("--events terminal error contract (F4)", () => {
  test("active writer keeps seq continuity when terminating with error", () => {
    const lines: string[] = [];
    const writer = new EventWriter("collect-x", (l) => lines.push(l));
    writer.start("radar.collect");
    writer.layer("firecrawl", false, 3);
    const active = EventWriter.active();
    expect(active).toBe(writer); // main's catch reuses the in-flight writer
    active!.error("adapter_failed", "boom");
    const events = lines.map((l) => JSON.parse(l) as { seq: number; event: string; code?: string });
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(events.at(-1)!.event).toBe("error");
    expect(events.at(-1)!.code).toBe("adapter_failed");
  });

  test("command failure in events mode ends stdout with an error event and non-zero exit", () => {
    const home = mkdtempSync(join(tmpdir(), "radar-events-"));
    const proc = Bun.spawnSync([process.execPath, CLI, "no-such-command", "--events"], {
      env: { ...process.env, RADAR_HOME: home, RADAR_DB_PATH: join(home, "radar.db") },
    });
    expect(proc.exitCode).not.toBe(0);
    const out = proc.stdout.toString().trim().split("\n").filter(Boolean);
    expect(out).toHaveLength(1); // nothing but the terminal error event
    const last = JSON.parse(out.at(-1)!) as { event: string; code: string };
    expect(last.event).toBe("error");
    expect(last.code).toBe("unknown_command");
  });
});
