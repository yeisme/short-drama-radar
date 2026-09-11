import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("market initialization, source revisions and reader config survive separate CLI processes", () => {
  const home = mkdtempSync(join(tmpdir(), "radar-market-cli-"));
  const invoke = (...args: string[]) => {
    const proc = Bun.spawnSync([process.execPath, "run", "src/cli.ts", ...args, "--json"], {
      cwd: process.cwd(),
      env: { ...process.env, RADAR_HOME: home, RADAR_DB_PATH: join(home, "radar.db"), RADAR_CONFIG_PATH: join(home, "config.json") },
    });
    return { exit: proc.exitCode, body: JSON.parse(proc.stdout.toString()) };
  };
  try {
    expect(invoke("market", "config", "show").body.error.code).toBe("market_required");
    const init = invoke("market", "init");
    expect(init.exit).toBe(0);
    expect(init.body.data.sources).toHaveLength(18);
    expect(init.body.data.sources.every((s: { readiness: string }) => s.readiness === "planned")).toBe(true);
    expect(init.body.data.settings).toEqual({ revision: 1, timezone: "UTC", blocked_topics: [] });
    expect(invoke("market", "source", "set", "--source", "hongguo", "--revision", "1", "--sampling-scope", "Daily public catalog").exit).toBe(0);
    expect(invoke("market", "source", "show", "--source", "hongguo").body.data.revision).toBe(2);
    expect(invoke("market", "source", "show", "--source", "hongguo", "--revision", "1").body.data.sampling_scope).toContain("Pending");
    expect(invoke("market", "source", "set", "--source", "hongguo", "--revision", "1", "--locale", "en").body.error.code).toBe("state_conflict");
    expect(invoke("market", "source", "set", "--source", "hongguo", "--revision", "2", "--readiness", "qualified").body.error.code).toBe("flag_invalid");
    expect(invoke("market", "config", "set", "--revision", "1", "--timezone", "Asia/Shanghai", "--blocked-topic", "taboo").body.data).toEqual({ revision: 2, timezone: "Asia/Shanghai", blocked_topics: ["taboo"] });
    expect(invoke("market", "init").body.data.settings.revision).toBe(2);
    expect(invoke("market", "source", "show", "--source", "hongguo").body.data.revision).toBe(2);
    expect(invoke("market", "config", "set", "--revision", "2", "--timezone", "not-a-zone").body.error.code).toBe("config_invalid");
    expect(invoke("market", "config", "set", "--revision", "2", "--clear-blocked-topics").body.data.blocked_topics).toEqual([]);
    expect(invoke("market", "config", "show", "--secret", "test-secret").body.error.message).not.toContain("test-secret");
    expect(invoke("market", "observe").body.error.code).toBe("command_unknown");
    const catalog = invoke("market", "import-catalog", "--source", "dramabox",
      "--file", "test/fixtures/market/dramabox.md", "--format", "markdown",
      "--observed-at", "2026-09-11T08:00:00Z", "--fixture");
    expect(catalog.exit).toBe(0);
    expect(catalog.body.data.items).toBe(2);
    expect(catalog.body.data.work_candidates_created).toBe(2);
    expect(catalog.body.data.origin).toBe("fixture");
    const works = invoke("market", "work", "list").body.data.works;
    expect(works).toHaveLength(2);
    expect(works.every((w: { mapping_status: string }) => w.mapping_status === "candidate")).toBe(true);
    const work = works[0].platform_work_ref;
    expect(invoke("market", "work", "show", "--work", work).body.data.platform_work_ref).toBe(work);
    expect(invoke("market", "work", "show", "--work", work, "--revision", "1").body.data.mapping_revision).toBe(1);
    expect(invoke("market", "work", "show", "--work", "work-missing").body.error.code).toBe("identity_not_found");
    expect(invoke("market", "work", "list", "--status", "invalid").body.error.code).toBe("flag_invalid");
    const evidence = works[0].supporting_evidence_refs[0];
    expect(invoke("market", "work", "review", "--work", work, "--revision", "1",
      "--evidence", evidence).body.error.code).toBe("value_required");
    expect(invoke("market", "work", "review", "--work", work, "--revision", "1",
      "--canonical", "canonical-1", "--evidence", "missing-evidence").body.error.code).toBe("evidence_not_found");
    const review = invoke("market", "work", "review", "--work", work, "--revision", "1",
      "--canonical", "canonical-1", "--evidence", evidence);
    expect(review.exit).toBe(0);
    expect(review.body.data.mapping).toMatchObject({ mapping_status: "verified", canonical_work_ref: "canonical-1" });
    expect(invoke("market", "work", "list", "--status", "verified").body.data.works[0].canonical_work_ref).toBe("canonical-1");
    expect(invoke("market", "work", "list", "--status", "candidate").body.data.works).toHaveLength(1);
    expect(invoke("market", "work", "review", "--work", work, "--revision", "1",
      "--canonical", "canonical-1", "--evidence", evidence).body.data.reused).toBe(true);
    expect(invoke("market", "work", "review", "--work", work, "--revision", "1",
      "--canonical", "canonical-2", "--evidence", evidence).body.error.code).toBe("state_conflict");
    expect(invoke("market", "import-catalog", "--source", "dramabox",
      "--file", "/nonexistent/private-location", "--format", "markdown",
      "--observed-at", "2026-09-11T08:00:00Z").body.error).toEqual({
        code: "input_unavailable", message: "Catalog file could not be read.",
      });
    expect(invoke("card", "2026-09-11").body.data.contract).toBe("short-drama-radar.card.v1");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 30000);
