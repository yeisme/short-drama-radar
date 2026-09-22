import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db/client.ts";
import { opportunities, readingJudgments } from "../../src/db/schema.ts";
import { buildEdition } from "../../src/pipeline/edition.ts";
import { ProfileService } from "../../src/profile/service.ts";
import { ConfigError, loadConfig } from "../../src/config.ts";
import { JudgmentConsumerError } from "../../src/judgment/consumer.ts";
import { judgmentAcceptCommand, judgmentEvaluateCommand, judgmentStatusCommand } from "../../src/judgment/cli.ts";
import type { RadarJudgmentConfig } from "../../src/config.ts";

// radar-reading-judgment-v1 task 2.1 — the user-configurable experimental
// gate: enabled defaults to false (evaluate/accept refuse before any flag
// parsing, transport assembly or write), mode off/shadow/assist defaults to
// off and acts as the evaluate default source once enabled, an explicit CLI
// --mode overrides it, and invalid config fails fast at load.

const databases: ReturnType<typeof openDb>[] = [];
const dirs: string[] = [];
afterEach(() => {
  databases.splice(0).forEach((db) => db.$client.close());
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function editionDb() {
  const db = openDb(":memory:");
  databases.push(db);
  const date = "2026-09-21";
  db.insert(opportunities).values({
    ref: "opp-config", date, clusterKey: "revenge|identity_reversal|default", topic: "revenge", hookFamily: "identity_reversal",
    format: "default", marketScore: 80, evidenceConfidence: 80, degraded: 0, crossPlatform: 0,
    evidenceDigest: "sha256:opp-config", sourceRefsJson: JSON.stringify(["douyin:opp-config"]),
    builderVersion: "opportunity-builder.v1", createdAt: "2026-09-21T00:00:00.000Z",
  }).run();
  const profile = new ProfileService(db).create("config", { topics: [{ tag: "revenge", weight: 90 }], minimum_confidence: 30, minimum_fit: 30 });
  buildEdition(db, profile, date);
  return db;
}

const flags = (entries: Record<string, string[]> = {}) => new Map(Object.entries(entries));
const config = (enabled: boolean, mode: RadarJudgmentConfig["mode"]): RadarJudgmentConfig => ({ enabled, mode });

function withConfigFile(contents: string, run: () => void): void {
  const dir = mkdtempSync(join(tmpdir(), "radar-judgment-config-"));
  dirs.push(dir);
  const saved = process.env.RADAR_CONFIG_PATH;
  process.env.RADAR_CONFIG_PATH = join(dir, "config.json");
  writeFileSync(process.env.RADAR_CONFIG_PATH, contents);
  try {
    run();
  } finally {
    if (saved === undefined) delete process.env.RADAR_CONFIG_PATH;
    else process.env.RADAR_CONFIG_PATH = saved;
  }
}

describe("judgment config parsing (fail-fast on invalid combinations)", () => {
  test("defaults are fully dormant: enabled=false, mode=off", () => {
    const saved = process.env.RADAR_CONFIG_PATH;
    process.env.RADAR_CONFIG_PATH = "/nonexistent/radar-judgment-config.json";
    try {
      expect(loadConfig().judgment).toEqual({ enabled: false, mode: "off" });
    } finally {
      if (saved === undefined) delete process.env.RADAR_CONFIG_PATH;
      else process.env.RADAR_CONFIG_PATH = saved;
    }
  });

  test("valid opt-in config parses", () => {
    withConfigFile(JSON.stringify({ judgment: { enabled: true, mode: "shadow" } }), () => {
      expect(loadConfig().judgment).toEqual({ enabled: true, mode: "shadow" });
    });
    withConfigFile(JSON.stringify({ judgment: { mode: "assist" } }), () => {
      // Partial section merges: enabled stays default false.
      expect(loadConfig().judgment).toEqual({ enabled: false, mode: "assist" });
    });
  });

  test("invalid judgment config is rejected at load with a stable error", () => {
    withConfigFile(JSON.stringify({ judgment: { enabled: "yes", mode: "shadow" } }), () => {
      expect(() => loadConfig()).toThrow(ConfigError);
      expect(() => loadConfig()).toThrow(/judgment.enabled must be a boolean/);
    });
    withConfigFile(JSON.stringify({ judgment: { enabled: true, mode: "live" } }), () => {
      expect(() => loadConfig()).toThrow(/judgment.mode must be one of off\|shadow\|assist/);
    });
    withConfigFile(JSON.stringify({ judgment: "on" }), () => {
      expect(() => loadConfig()).toThrow(/judgment must be an object/);
    });
    withConfigFile(JSON.stringify({ judgment: { enabled: 1 } }), () => {
      expect(() => loadConfig()).toThrow(ConfigError);
    });
  });
});

describe("experimental gate on the judgment CLI", () => {
  test("default disabled: evaluate and accept refuse before flags, transports or writes", async () => {
    const db = editionDb();
    const evaluate = judgmentEvaluateCommand(db, flags({ mode: ["assist"], transport: ["fixture"] }), config(false, "off"));
    await expect(evaluate).rejects.toThrow(JudgmentConsumerError);
    await expect(evaluate).rejects.toMatchObject({ code: "capability_disabled" });
    // The gate precedes flag validation: even an invalid flag reports the gate.
    await expect(judgmentEvaluateCommand(db, flags({ nonsense: ["x"] }), config(false, "off"))).rejects.toMatchObject({ code: "capability_disabled" });
    // Adoption is gated with it; nothing reached the feedback flow or the store.
    expect(() => judgmentAcceptCommand(db, flags({ attempt: ["rj-x-a1"], candidate: ["cand-1"], kind: ["saved"] }), config(false, "off"))).toThrow(JudgmentConsumerError);
    expect(db.select().from(readingJudgments).all()).toHaveLength(0);
    // Status stays available as the zero-call explanation surface.
    const status = judgmentStatusCommand(db, config(false, "off"));
    expect(status.facts?.experimental_enabled).toBe(false);
    expect(status.facts?.default_mode).toBe("off");
    expect(status.facts?.model_calls_this_command).toBe(0);
  });

  test("enabled + configured mode: evaluate uses the config default and writes one attempt", async () => {
    const db = editionDb();
    const result = await judgmentEvaluateCommand(db, flags({ transport: ["fixture"] }), config(true, "assist"));
    expect(result.status).toBe("success");
    expect(result.facts?.mode).toBe("assist");
    expect(result.facts?.transport_evaluate_calls).toBe(1);
    expect(db.select().from(readingJudgments).all()).toHaveLength(1);
    // Status now reports the enabled experimental state.
    expect(judgmentStatusCommand(db, config(true, "assist")).facts?.experimental_enabled).toBe(true);
  });

  test("explicit CLI --mode overrides the configured default mode", async () => {
    const db = editionDb();
    const override = await judgmentEvaluateCommand(db, flags({ mode: ["shadow"], transport: ["fixture"] }), config(true, "assist"));
    expect(override.facts?.mode).toBe("shadow");
    const explicitAssist = await judgmentEvaluateCommand(db, flags({ mode: ["assist"], transport: ["fixture"], fresh: ["true"] }), config(true, "shadow"));
    expect(explicitAssist.facts?.mode).toBe("assist");
  });

  test("enabled with mode=off still requires an explicit per-run --mode", async () => {
    const db = editionDb();
    await expect(judgmentEvaluateCommand(db, flags({ transport: ["fixture"] }), config(true, "off")))
      .rejects.toMatchObject({ code: "mode_required" });
    const explicit = await judgmentEvaluateCommand(db, flags({ mode: ["assist"], transport: ["fixture"] }), config(true, "off"));
    expect(explicit.facts?.mode).toBe("assist");
  });

  test("disabling again is a single flip that restores the dormant old flow", async () => {
    const db = editionDb();
    await judgmentEvaluateCommand(db, flags({ transport: ["fixture"] }), config(true, "assist"));
    const stored = db.select().from(readingJudgments).all();
    expect(stored.length).toBeGreaterThan(0);
    // Flip enabled back to false; a residual active mode must stay dormant.
    await expect(judgmentEvaluateCommand(db, flags({ mode: ["assist"], transport: ["fixture"] }), config(false, "assist")))
      .rejects.toMatchObject({ code: "capability_disabled" });
    expect(db.select().from(readingJudgments).all()).toEqual(stored);
    const status = judgmentStatusCommand(db, config(false, "assist"));
    expect(status.facts?.experimental_enabled).toBe(false);
    expect(status.summary).toContain("DISABLED");
  });
});
