import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db/client.ts";
import { dailyItems, rawSnapshots, runs } from "../../src/db/schema.ts";
import { buildHealthReport, isStableId } from "../../src/pipeline/health.ts";
import { buildScheduleUnits, SCHEDULE_NEXT_STEPS, systemdUserDir } from "../../src/schedule.ts";
import { defaultConfig } from "../../src/config.ts";

describe("schedule units (task: systemd wiring)", () => {
  const units = buildScheduleUnits(defaultConfig, "/usr/local/bin/bun /opt/radar/src/cli.ts");

  test("collect timer wires both morning passes", () => {
    expect(units["short-drama-radar-collect.timer"]).toContain("OnCalendar=*-*-* 08:10:00");
    expect(units["short-drama-radar-collect.timer"]).toContain("OnCalendar=*-*-* 08:30:00");
    expect(units["short-drama-radar-collect.timer"]).toContain("Persistent=true");
    expect(units["short-drama-radar-collect.timer"]).toContain("WantedBy=timers.target");
  });

  test("score and card timers hit 08:42 and 08:55/08:59", () => {
    expect(units["short-drama-radar-score.timer"]).toContain("OnCalendar=*-*-* 08:42:00");
    expect(units["short-drama-radar-card.timer"]).toContain("OnCalendar=*-*-* 08:55:00");
    expect(units["short-drama-radar-card.timer"]).toContain("OnCalendar=*-*-* 08:59:00");
  });

  test("services are hardened oneshots with json envelopes to the journal", () => {
    const svc = units["short-drama-radar-collect.service"];
    expect(svc).toContain("Type=oneshot");
    expect(svc).toContain("ExecStart=/usr/bin/flock -w 600 %h/.short-drama-radar/radar.lock /usr/local/bin/bun /opt/radar/src/cli.ts collect --json");
    expect(svc).toContain("NoNewPrivileges=yes");
    expect(svc).toContain("PrivateTmp=yes");
    expect(svc).toContain('Environment="PATH=');
    expect(svc).not.toMatch(/cookie|password|token/i);
  });

  test("install next steps are systemd user commands", () => {
    expect(SCHEDULE_NEXT_STEPS[0]).toBe("systemctl --user daemon-reload");
    expect(SCHEDULE_NEXT_STEPS.join(" ")).toContain("enable --now");
    expect(systemdUserDir("/home/u")).toBe("/home/u/.config/systemd/user");
  });
});

describe("collection health report", () => {
  function seed() {
    const dir = mkdtempSync(join(tmpdir(), "radar-health-"));
    const db = openDb(join(dir, "t.db"));
    // Day 1: both platforms, healthy, stable ids, second-pass duplicates.
    for (const p of ["douyin", "xiaohongshu"]) {
      for (let i = 0; i < 5; i++) {
        db.insert(dailyItems).values({
          date: "2026-08-28", platform: p, contentId: p === "douyin" ? `74000000000000010${i}` : `6600000000000001${i}1`,
          title: `t${i}`, metricsJson: "{}", score: 50, confidence: 70, updatedAt: "2026-08-28T08:30:00Z",
        }).run();
      }
    }
    for (let i = 0; i < 12; i++) {
      db.insert(rawSnapshots).values({
        runId: "collect-2026-08-28a", platform: i < 6 ? "douyin" : "xiaohongshu", layer: 0, source: "firecrawl",
        contentId: `id${i}`, title: "", url: "", metricsJson: "{}", payloadHash: "", confidence: 40, fetchedAt: "2026-08-28T08:10:00Z",
      }).run();
    }
    db.insert(runs).values({ id: "collect-2026-08-28a", kind: "collect", startedAt: "2026-08-28T08:10:00Z", finishedAt: "2026-08-28T08:12:00Z", status: "ok", summaryJson: JSON.stringify({ degradedLayers: [] }) }).run();
    // Day 2: degraded layer + one unstable id.
    db.insert(dailyItems).values({ date: "2026-08-29", platform: "douyin", contentId: "740000000000000201", title: "ok", metricsJson: "{}", score: 60, confidence: 70, updatedAt: "2026-08-29T08:30:00Z" }).run();
    db.insert(dailyItems).values({ date: "2026-08-29", platform: "xiaohongshu", contentId: "sha:abc123", title: "bad-id", metricsJson: "{}", score: 30, confidence: 40, updatedAt: "2026-08-29T08:30:00Z" }).run();
    db.insert(runs).values({ id: "collect-2026-08-29a", kind: "collect", startedAt: "2026-08-29T08:10:00Z", finishedAt: "2026-08-29T08:12:00Z", status: "degraded", summaryJson: JSON.stringify({ degradedLayers: ["agent-reach-xhs"] }) }).run();
    // Day 3: a real attempt that produced no data must still count as degraded.
    db.insert(runs).values({ id: "collect-2026-08-30T08:10:00Z", kind: "collect", startedAt: "collect-2026-08-30T08:10:00Z", finishedAt: "2026-08-30T08:12:00Z", status: "degraded", summaryJson: JSON.stringify({ degradedLayers: ["firecrawl-douyin", "firecrawl-xiaohongshu"] }) }).run();
    return db;
  }

  test("summarizes coverage, duplicates, degraded days and stable-id violations", () => {
    const report = buildHealthReport(seed(), 14, new Date("2026-09-02T00:00:00Z"));
    expect(report.daysWithAttempt).toBe(3);
    expect(report.daysWithCollection).toBe(2);
    expect(report.degradedDays).toBe(2);
    expect(report.coverageDays.both).toBe(2);
    expect(report.stableIdViolationTotal).toBe(1);
    const d1 = report.days.find((d) => d.date === "2026-08-28")!;
    expect(d1.platformsCovered.sort()).toEqual(["douyin", "xiaohongshu"]);
    expect(d1.items).toBe(10);
    expect(d1.duplicateSnapshotRate).toBeCloseTo(0.17, 1); // 12 snapshots vs 10 items
    const d2 = report.days.find((d) => d.date === "2026-08-29")!;
    expect(d2.degraded).toBe(true);
    expect(d2.degradedLayers).toContain("agent-reach-xhs");
    const d3 = report.days.find((d) => d.date === "2026-08-30")!;
    expect(d3.collectAttempts).toBe(1);
    expect(d3.items).toBe(0);
    expect(d3.degraded).toBe(true);
  });

  test("reports account survival without exposing credential refs or handles", () => {
    const dir = mkdtempSync(join(tmpdir(), "radar-health-accounts-"));
    const accountsPath = join(dir, "accounts.json");
    writeFileSync(accountsPath, JSON.stringify({
      version: 1,
      accounts: [
        { id: "x1", platform: "xiaohongshu", status: "active", credentialRef: "secret:x1", handleMasked: "x***1" },
        { id: "x2", platform: "xiaohongshu", status: "cooldown", credentialRef: "secret:x2", handleMasked: "x***2" },
        { id: "d1", platform: "douyin", status: "disabled", credentialRef: "secret:d1", handleMasked: "d***1" },
      ],
    }));
    const report = buildHealthReport(seed(), 14, new Date("2026-09-02T00:00:00Z"), accountsPath);
    expect(report.accountSurvival).toEqual({
      configured: 3,
      active: 1,
      cooldown: 1,
      disabled: 1,
      byPlatform: {
        xiaohongshu: { configured: 2, active: 1, cooldown: 1, disabled: 0 },
        douyin: { configured: 1, active: 0, cooldown: 0, disabled: 1 },
      },
    });
    expect(JSON.stringify(report.accountSurvival)).not.toContain("secret:");
    expect(JSON.stringify(report.accountSurvival)).not.toContain("***");
  });

  test("stable id shapes per platform", () => {
    expect(isStableId("douyin", "7400000000000001234")).toBe(true);
    expect(isStableId("douyin", "2630652")).toBe(true);
    expect(isStableId("douyin", "video_abc")).toBe(false);
    expect(isStableId("xiaohongshu", "660000000000000101")).toBe(true);
    expect(isStableId("xiaohongshu", "sha256hash")).toBe(false);
  });
});
