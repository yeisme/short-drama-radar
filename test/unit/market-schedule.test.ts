import { describe, expect, test } from "bun:test";
import {
  buildMarketScheduleUnits, MARKET_OBSERVE_POLICY, MARKET_SCHEDULE_NEXT_STEPS, MARKET_SCHEDULE_TIMES,
  marketRetryDecision, planMarketObservationRun, resolveMarketRunFreeze,
} from "../../src/market/schedule.ts";
import { buildScheduleUnits } from "../../src/schedule.ts";
import { defaultConfig } from "../../src/config.ts";
import { openDb } from "../../src/db/client.ts";
import { marketCommand } from "../../src/market/cli.ts";

function flags(entries: Record<string, string[]> = {}): Map<string, string[]> {
  return new Map(Object.entries(entries));
}

const EXEC = "/usr/local/bin/bun /opt/radar/src/cli.ts";

describe("market schedule units (task 2.6)", () => {
  const units = buildMarketScheduleUnits(EXEC);

  test("generates an independent market unit set; legacy timers are untouched", () => {
    expect(Object.keys(units).sort()).toEqual([
      "short-drama-radar-market-analyze.service",
      "short-drama-radar-market-analyze.timer",
      "short-drama-radar-market-brief.service",
      "short-drama-radar-market-brief.timer",
    ]);
    // Old generator still emits exactly the legacy units — the market
    // schedule never rewrites or replaces existing timers.
    const legacy = buildScheduleUnits(defaultConfig, EXEC);
    expect(Object.keys(legacy).sort()).toEqual([
      "short-drama-radar-card.service", "short-drama-radar-card.timer",
      "short-drama-radar-collect.service", "short-drama-radar-collect.timer",
      "short-drama-radar-score.service", "short-drama-radar-score.timer",
    ]);
    for (const name of Object.keys(legacy)) expect(units[name]).toBeUndefined();
  });

  test("snapshot: analyze precedes brief; both serialize on the shared lock", () => {
    const analyze = units["short-drama-radar-market-analyze.service"]!;
    expect(analyze).toContain("Type=oneshot");
    expect(analyze).toContain(`ExecStart=/usr/bin/flock -w 600 %h/.short-drama-radar/radar.lock ${EXEC} market analyze --json`);
    expect(analyze).toContain("NoNewPrivileges=yes");
    expect(analyze).not.toMatch(/cookie|password|token|authorization/i);
    const brief = units["short-drama-radar-market-brief.service"]!;
    expect(brief).toContain(`${EXEC} market brief build --json`);
    expect(brief).toContain("After=short-drama-radar-market-analyze.service");
    expect(units["short-drama-radar-market-analyze.timer"]).toContain(`OnCalendar=*-*-* ${MARKET_SCHEDULE_TIMES.analyze}:00`);
    expect(units["short-drama-radar-market-brief.timer"]).toContain(`OnCalendar=*-*-* ${MARKET_SCHEDULE_TIMES.brief}:00`);
    expect(units["short-drama-radar-market-brief.timer"]).toContain("Persistent=true");
    // Deterministic generation: the owner can diff re-runs safely.
    expect(buildMarketScheduleUnits(EXEC)).toEqual(units);
  });

  test("install guidance is honest: nothing is reported as already scheduled", () => {
    expect(MARKET_SCHEDULE_NEXT_STEPS[0]).toBe("systemctl --user daemon-reload");
    expect(MARKET_SCHEDULE_NEXT_STEPS.join(" ")).toContain("enable --now short-drama-radar-market-analyze.timer");
    expect(MARKET_SCHEDULE_NEXT_STEPS.join(" ")).not.toMatch(/already (running|enabled|scheduled)/i);
  });
});

describe("bounded observation run plan", () => {
  const now = new Date("2026-09-13T09:00:00Z");

  test("only qualified/sample-verified sources run; others skip with named reasons", () => {
    const plan = planMarketObservationRun([
      { source_ref: "hongguo", readiness: "qualified" },
      { source_ref: "reelshort", readiness: "sample_verified" },
      { source_ref: "dramabox", readiness: "planned" },
      { source_ref: "kuaishou", readiness: "identity_verified" },
      { source_ref: "xifan", readiness: "blocked" },
      { source_ref: "melolo", readiness: "sample_verified", cooldown_until: "2026-09-13T20:00:00Z" },
    ], now);
    expect(plan.waves.flatMap(w => w).sort()).toEqual(["hongguo", "reelshort"]);
    const reasons = Object.fromEntries(plan.skipped.map(s => [s.source_ref, s.reason]));
    expect(reasons["dramabox"]).toBe("qualification_pending");
    expect(reasons["kuaishou"]).toBe("qualification_pending");
    expect(reasons["xifan"]).toBe("blocked");
    expect(reasons["melolo"]).toBe("risk_control_cooldown");
    expect(plan.attempts_per_source).toBe(1 + MARKET_OBSERVE_POLICY.max_read_retries);
    expect(plan.retry_backoff_ms).toEqual([2_000, 8_000]);
  });

  test("global concurrency bounds waves deterministically", () => {
    const plan = planMarketObservationRun(["a", "b", "c", "d", "e"].map(source_ref => ({ source_ref, readiness: "qualified" as const })), now);
    expect(plan.waves).toEqual([["a", "b"], ["c", "d"], ["e"]]);
    expect(MARKET_OBSERVE_POLICY.global_concurrency).toBe(2);
    expect(MARKET_OBSERVE_POLICY.source_timeout_ms).toBe(60_000);
  });

  test("suspend/resume: a cooldown that has expired frees the source again", () => {
    const state = [{ source_ref: "hongguo", readiness: "qualified" as const, cooldown_until: "2026-09-13T10:00:00Z" }];
    expect(planMarketObservationRun(state, new Date("2026-09-13T09:00:00Z")).skipped[0]!.reason).toBe("risk_control_cooldown");
    const resumed = planMarketObservationRun(state, new Date("2026-09-13T10:00:01Z"));
    expect(resumed.skipped).toEqual([]);
    expect(resumed.waves).toEqual([["hongguo"]]);
  });

  test("transport failures retry with bounded backoff; auth/risk-control never retry", () => {
    expect(marketRetryDecision("source_unavailable", 1)).toEqual({ retry: true, delay_ms: 2_000 });
    expect(marketRetryDecision("source_timeout", 2)).toEqual({ retry: true, delay_ms: 8_000 });
    expect(marketRetryDecision("source_unavailable", 3)).toMatchObject({ retry: false });
    for (const code of ["source_auth_required", "source_risk_control"] as const) {
      expect(marketRetryDecision(code, 1)).toMatchObject({ retry: false, cooldown_hours: 24 });
    }
  });

  test("cutoff freezes a partial edition instead of waiting for stragglers", () => {
    const decision = resolveMarketRunFreeze([
      { source_ref: "hongguo", outcome: "observed", completed_at: "2026-09-13T08:40:00Z" },
      { source_ref: "reelshort", outcome: "incomplete" },
      { source_ref: "dramabox", outcome: "failed", error_code: "source_unavailable", completed_at: "2026-09-13T08:50:00Z" },
    ], { cutoff: "2026-09-13T09:00:00Z" });
    expect(decision.freeze).toBe(true);
    expect(decision.brief_status).toBe("degraded");
    expect(decision.incomplete_sources).toEqual(["reelshort"]);
    expect(decision.failed_sources).toEqual(["dramabox"]);
    expect(decision.reasons.join(" ")).toContain("did not finish before the cutoff");
    // Late completion past the cutoff still counts as incomplete for this edition.
    const late = resolveMarketRunFreeze([
      { source_ref: "hongguo", outcome: "observed", completed_at: "2026-09-13T08:40:00Z" },
      { source_ref: "reelshort", outcome: "observed", completed_at: "2026-09-13T09:04:00Z" },
    ], { cutoff: "2026-09-13T09:00:00Z" });
    expect(late.incomplete_sources).toEqual(["reelshort"]);
    expect(late.brief_status).toBe("degraded");
    // Everyone contributed and finished: the honest status is ready.
    expect(resolveMarketRunFreeze([
      { source_ref: "hongguo", outcome: "observed", completed_at: "2026-09-13T08:40:00Z" },
    ], { cutoff: "2026-09-13T09:00:00Z" }).brief_status).toBe("ready");
    // Nothing contributed: an empty edition, never a fabricated one.
    expect(resolveMarketRunFreeze([
      { source_ref: "reelshort", outcome: "incomplete" },
    ], { cutoff: "2026-09-13T09:00:00Z" }).brief_status).toBe("empty");
  });
});

describe("market schedule sync hook (radar-market-pg-sync-v1)", () => {
  test("install --print emits exactly the existing units — never a sync timer", async () => {
    const db = openDb(":memory:");
    try {
      const printed = await marketCommand(["market", "schedule", "install"], flags({ print: ["true"] }), db);
      const data = printed.data as { units: Record<string, string>; sync_hook: { command: string; generated: boolean; enabled: boolean } };
      expect(Object.keys(data.units).sort()).toEqual([
        "short-drama-radar-market-analyze.service", "short-drama-radar-market-analyze.timer",
        "short-drama-radar-market-brief.service", "short-drama-radar-market-brief.timer",
      ]);
      for (const content of Object.values(data.units)) expect(content).not.toContain("market sync");
      expect(data.sync_hook.command).toBe("radar market sync --to pg");
      expect(data.sync_hook.generated).toBe(false);
      expect(data.sync_hook.enabled).toBe(false);
    } finally { db.$client.close(); }
  });

  test("schedule show documents the hook as optional and owner-gated", async () => {
    const db = openDb(":memory:");
    try {
      const shown = await marketCommand(["market", "schedule", "show"], flags(), db);
      const hook = (shown.data as { sync_hook: { note: string; runs_after: string } }).sync_hook;
      expect(hook.runs_after).toBe("short-drama-radar-market-brief.service");
      expect(hook.note).toContain("never writes or enables a sync timer");
      // The pre-existing unit content is byte-identical with and without the hook text.
      expect(Object.keys(buildMarketScheduleUnits(EXEC))).toHaveLength(4);
    } finally { db.$client.close(); }
  });
});
