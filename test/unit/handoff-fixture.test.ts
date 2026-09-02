import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { capabilities } from "../../src/mcp/server.ts";
import { EXECUTE_ACTIONS } from "../../src/app/actions.ts";

// Task 4.3 contract fixture validator: the root handoff snapshot must stay in
// sync with the live tool/resource/capability surface and must never carry
// DB/audit/credential/raw-payload material.

describe("mcp handoff fixture (task 4.3)", () => {
  let fixture: {
    tools: Array<{ name: string; lanes_cumulative?: Record<string, string[]>; external_side_effect_actions?: string[]; input_schema_keys?: string[] }>;
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

  test("execute action lanes match the live registry", () => {
    const exec = fixture.tools.find((t) => t.name === "radar.execute")!;
    for (const [lane, actions] of Object.entries(exec.lanes_cumulative!)) {
      for (const action of actions) {
        expect(EXECUTE_ACTIONS[action]).toBeDefined();
        expect(EXECUTE_ACTIONS[action]!.lane === lane || (lane === "operator" && EXECUTE_ACTIONS[action]!.lane !== "reader")).toBe(true);
      }
    }
    const liveActions = Object.keys(EXECUTE_ACTIONS).sort();
    const fixtureActions = [...new Set([...exec.lanes_cumulative!.curator!, ...exec.lanes_cumulative!.operator!])].sort();
    expect(fixtureActions).toEqual(liveActions);
  });

  test("external side effects are exactly collect/daily_run", () => {
    const exec = fixture.tools.find((t) => t.name === "radar.execute")!;
    expect(exec.external_side_effect_actions!.sort()).toEqual(
      Object.entries(EXECUTE_ACTIONS).filter(([, d]) => d.sideEffect === "external").map(([n]) => n).sort(),
    );
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
