import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../../src/config.ts";
import { MARKET_SCHEDULE_TIMES } from "../../src/market/schedule.ts";
import { buildScheduleUnits, SCHEDULE_NEXT_STEPS } from "../../src/schedule.ts";
import {
  buildSchedulePlan, detectScheduleBackend, parseScheduleBackend, parseSessionRuntime,
} from "../../src/schedule-plan.ts";
import { buildLaunchdUnits, launchdUserDir } from "../../src/schedule-launchd.ts";
import { buildWindowsUnits, windowsTaskDir } from "../../src/schedule-windows.ts";
import { buildSessionPlan, sessionPlanActions } from "../../src/schedule-session.ts";
import { probeSchedule } from "../../src/diagnostics.ts";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXEC = "/usr/local/bin/bun /opt/radar/src/cli.ts";

describe("portable schedule plan", () => {
  const plan = buildSchedulePlan(defaultConfig, "linux");

  test("pipeline wall-clock times match the existing morning windows", () => {
    expect(plan.spec).toBe("radar.schedule.plan.v1");
    expect(plan.backend_auto).toBe("systemd");
    const byId = Object.fromEntries(plan.pipeline.map((j) => [j.id, j]));
    expect(byId.collect?.local_times).toEqual(["08:10", "08:30"]);
    expect(byId.score?.local_times).toEqual(["08:42"]);
    expect(byId.card?.local_times).toEqual(["08:55", "08:59"]);
    expect(byId.collect?.class).toBe("wall_clock");
  });

  test("market wall-clock stays aligned with the market schedule module", () => {
    const byId = Object.fromEntries(plan.market.map((j) => [j.id, j]));
    expect(byId["market-analyze"]?.local_times).toEqual([MARKET_SCHEDULE_TIMES.analyze]);
    expect(byId["market-brief"]?.local_times).toEqual([MARKET_SCHEDULE_TIMES.brief]);
    expect(byId["market-observe"]?.readiness).toBe("planned");
  });

  test("detects backends and rejects unknown names", () => {
    expect(detectScheduleBackend("linux")).toBe("systemd");
    expect(detectScheduleBackend("darwin")).toBe("launchd");
    expect(detectScheduleBackend("win32")).toBe("windows");
    expect(parseScheduleBackend("auto", "darwin")).toBe("launchd");
    expect(parseSessionRuntime(undefined)).toBe("both");
    expect(() => parseScheduleBackend("cron")).toThrow(/backend_invalid/);
    expect(() => parseSessionRuntime("openclaw")).toThrow(/runtime_invalid/);
  });
});

describe("launchd and windows generators", () => {
  test("launchd plists use calendar intervals and omit secrets", () => {
    const units = buildLaunchdUnits(defaultConfig, EXEC);
    expect(Object.keys(units).sort()).toEqual([
      "com.yeisme.short-drama-radar.card.plist",
      "com.yeisme.short-drama-radar.collect.plist",
      "com.yeisme.short-drama-radar.score.plist",
    ]);
    const collect = units["com.yeisme.short-drama-radar.collect.plist"]!;
    expect(collect).toContain("<integer>8</integer>");
    expect(collect).toContain("<integer>10</integer>");
    expect(collect).toContain("<integer>30</integer>");
    expect(collect).toContain("/opt/radar/src/cli.ts");
    expect(collect).toContain("collect");
    expect(collect).toContain("--json");
    expect(collect).not.toMatch(/cookie|password|token|authorization/i);
    expect(launchdUserDir("/Users/u")).toBe("/Users/u/Library/LaunchAgents");
  });

  test("windows XML has catch-up, single-instance, and no secrets", () => {
    const units = buildWindowsUnits(defaultConfig, EXEC);
    const collect = units["short-drama-radar-collect.xml"]!;
    expect(collect).toContain("2020-01-01T08:10:00");
    expect(collect).toContain("2020-01-01T08:30:00");
    expect(collect).toContain("<StartWhenAvailable>true</StartWhenAvailable>");
    expect(collect).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
    expect(collect).toContain("InteractiveToken");
    expect(collect).toContain("LeastPrivilege");
    expect(collect).toContain("collect --json");
    expect(collect).not.toMatch(/cookie|password|authorization|api[_-]?key/i);
    expect(windowsTaskDir("/Users/u", "")).toBe(join("/Users/u", "AppData", "Local", "short-drama-radar", "tasks"));
  });

  test("systemd generator is unchanged beside the new backends", () => {
    const units = buildScheduleUnits(defaultConfig, EXEC);
    expect(units["short-drama-radar-collect.timer"]).toContain("OnCalendar=*-*-* 08:10:00");
    expect(units["short-drama-radar-collect.service"]).toContain("/usr/bin/flock -w 600");
  });
});

describe("session plan", () => {
  test("prints read-only loops and never live collect", () => {
    const plan = buildSessionPlan("both");
    expect(plan.spec).toBe("radar.schedule.session_plan.v1");
    const prompts = plan.jobs.map((j) => `${j.prompt}\n${j.grok_loop}\n${j.claude_loop}`).join("\n");
    expect(prompts).not.toMatch(/radar collect|radar run|confirm-live/);
    expect(plan.jobs.map((j) => j.id).sort()).toEqual(["morning-read", "reach-watch"]);
    expect(plan.jobs[0]?.grok_loop.startsWith("/loop 1d ")).toBe(true);
    expect(plan.jobs[0]?.claude_cron).toBe("0 9 * * *");
    expect(plan.limitations.some((l) => l.includes("not wall-clock"))).toBe(true);
    const actions = sessionPlanActions(plan);
    expect(actions.some((a) => a.name.startsWith("grok-"))).toBe(true);
    expect(actions.some((a) => a.name.startsWith("claude-loop-"))).toBe(true);
  });
});

describe("doctor schedule probe", () => {
  test("linux without systemd manager points at session-plan", () => {
    const dir = mkdtempSync(join(tmpdir(), "radar-sched-"));
    mkdirSync(join(dir, ".config/systemd/user"), { recursive: true });
    writeFileSync(join(dir, ".config/systemd/user/short-drama-radar-collect.timer"), "# stub\n");
    const check = probeSchedule(dir, "linux");
    expect(check.status).toBe("blocked");
    expect(
      check.nextCommand === "radar schedule session-plan --runtime both --json"
        || check.nextCommand === SCHEDULE_NEXT_STEPS[1],
    ).toBe(true);
  });

  test("darwin without plist is unavailable with launchd install", () => {
    const dir = mkdtempSync(join(tmpdir(), "radar-mac-"));
    const check = probeSchedule(dir, "darwin");
    expect(check.status).toBe("unavailable");
    expect(check.nextCommand).toBe("radar schedule install --backend launchd");
  });
});
