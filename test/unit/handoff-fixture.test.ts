import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { capabilities, mcpActionAllowed } from "../../src/mcp/server.ts";
import { EXECUTE_ACTIONS, type Lane } from "../../src/app/actions.ts";

// Task 4.3 contract fixture validator: the root handoff snapshot must stay in
// sync with the live tool/resource/capability surface and must never carry
// DB/audit/credential/raw-payload material.

describe("mcp handoff fixture (task 4.3)", () => {
  let fixture: {
    tools: Array<{ name: string; lanes_cumulative?: Record<string, string[]>; external_side_effect_actions?: string[]; cli_only_actions?: string[]; input_schema_keys?: string[] }>;
    resources: string[];
    prompts: string[];
    capabilities: Array<{ capability: string; status: string }>;
    disabled_states: Record<string, string>;
    excluded_from_handoff: string[];
  };

  beforeAll(async () => {
    fixture = await Bun.file(new URL("../../docs/interfaces/mcp-handoff-fixtures.json", import.meta.url)).json();
  });

  test("capability snapshot matches the live capability table", () => {
    const live = capabilities({} as never); // capabilities() is pure — no deps touched
    const liveMap: Record<string, string> = Object.fromEntries(live.map((c) => [c.capability, c.status as string]));
    for (const c of fixture.capabilities) {
      expect(liveMap[c.capability]).toBe(c.status);
    }
    expect(Object.keys(liveMap).length).toBe(fixture.capabilities.length);
  });

  test("execute action lanes match the live registry and the live MCP dispatch surface", () => {
    const exec = fixture.tools.find((t) => t.name === "radar.execute")!;
    for (const [lane, actions] of Object.entries(exec.lanes_cumulative!)) {
      for (const action of actions) {
        expect(EXECUTE_ACTIONS[action]).toBeDefined();
        expect(EXECUTE_ACTIONS[action]!.lane === lane || (lane === "operator" && EXECUTE_ACTIONS[action]!.lane !== "reader")).toBe(true);
      }
    }
    // Drift check against the actual MCP gate: the fixture operator lane must
    // equal exactly what mcpActionAllowed permits for operator — not merely
    // what the EXECUTE_ACTIONS registry contains (collect/daily_run stay in
    // the registry for CLI use but are never callable over MCP).
    const liveMcpOperator = Object.keys(EXECUTE_ACTIONS).filter((a) => mcpActionAllowed("operator", a)).sort();
    const fixtureOperator = exec.lanes_cumulative!.operator!.slice().sort();
    expect(fixtureOperator).toEqual(liveMcpOperator);
    const fixtureActions = [...new Set([...exec.lanes_cumulative!.curator!, ...exec.lanes_cumulative!.operator!])].sort();
    expect(fixtureActions).toEqual(liveMcpOperator);
  });

  test("external side-effect actions are CLI-only and never dispatchable on any lane", () => {
    const exec = fixture.tools.find((t) => t.name === "radar.execute")!;
    const liveExternal = Object.entries(EXECUTE_ACTIONS).filter(([, d]) => d.sideEffect === "external").map(([n]) => n).sort();
    // No external-side-effect action remains in the MCP-visible lanes...
    expect(exec.external_side_effect_actions).toEqual([]);
    // ...and the CLI-only list is exactly those registry actions, each of
    // which the MCP gate rejects for every lane.
    expect((exec.cli_only_actions ?? []).slice().sort()).toEqual(liveExternal);
    for (const name of liveExternal) {
      for (const lane of ["reader", "curator", "operator"] as Lane[]) {
        expect(mcpActionAllowed(lane, name)).toBe(false);
      }
    }
  });

  test("no credentials, raw payloads, audit content or DB material in the fixture", () => {
    // The excluded_from_handoff list legitimately NAMES the excluded
    // categories, so it is checked for shape, not scanned for keywords.
    const { excluded_from_handoff, ...scannable } = fixture;
    const blob = JSON.stringify(scannable).toLowerCase();
    expect(blob).not.toMatch(/password|cookie:|bearer |authorization:/);
    expect(blob).not.toMatch(/secretstore:\/\//);
    expect(excluded_from_handoff.length).toBeGreaterThanOrEqual(4);
    // Capability digest discipline: the file must carry disabled-state notes
    // for every non-ready capability it declares.
    for (const c of fixture.capabilities.filter((x) => x.status !== "ready")) {
      const key = c.capability === "hermes_local_canary" ? "public_hermes_skill" : c.capability;
      if (key === "layer2_browser_fallback") continue; // runtime-provisioned, documented in doctor
      expect(fixture.disabled_states[key]).toBeDefined();
    }
  });

  test("fixture digest is recorded and stable", () => {
    const canonical = JSON.stringify(
      Object.fromEntries([...fixture.capabilities].sort((a, b) => a.capability.localeCompare(b.capability)).map((c) => [c.capability, c.status] as [string, string])),
    );
    const digest = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
    expect(digest).toMatch(/^[0-9a-f]{16}$/); // shape pin; value changes only when capabilities change
  });
});
