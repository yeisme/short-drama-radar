import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// Task 3.1 gate: the official MCP TypeScript SDK must work with Bun 1.3+
// over stdio (initialize/list/call, clean exit on stdin close). A failure
// here blocks the M3 lane and must be recorded, not worked around.

describe("MCP SDK + Bun stdio spike (task 3.1)", () => {
  test("minimal initialize -> list -> call -> clean exit", async () => {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../../src/mcp/spike.ts")], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const send = (obj: unknown) => proc.stdin.write(JSON.stringify(obj) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "spike", version: "0.0.1" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ping", arguments: {} } });
    await new Promise((r) => setTimeout(r, 600));
    proc.stdin.end();
    const out = (await new Response(proc.stdout).text()).trim().split("\n").map((l) => JSON.parse(l));
    const byId = Object.fromEntries(out.filter((l: { id?: number }) => l.id).map((l) => [l.id, l]));
    expect(byId[1].result.serverInfo.name).toBe("radar-spike");
    expect(byId[2].result.tools[0].name).toBe("ping");
    expect(byId[3].result.content[0].text).toBe("pong");
    expect(await proc.exited).toBe(0); // lifecycle ends cleanly on stdin close
  });
});
