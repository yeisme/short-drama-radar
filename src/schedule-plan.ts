import { join } from "node:path";
import type { RadarConfig } from "./config.ts";

// Keep in sync with MARKET_SCHEDULE_TIMES in market/schedule.ts without
// importing that module (Radar generates no units; this is plan data only).
const MARKET_WALL_CLOCK = { analyze: "08:50", brief: "09:00" } as const;

export type ScheduleBackend = "systemd" | "launchd" | "windows";
export type SessionRuntime = "grok" | "claude" | "both";
export type JobClass = "wall_clock" | "session_read";

export interface ScheduleJob {
  id: string;
  class: JobClass;
  command: string;
  local_times: string[];
  after: string[];
  readiness: "schedulable" | "planned";
}

export interface SchedulePlan {
  spec: "radar.schedule.plan.v1";
  backend_auto: ScheduleBackend;
  pipeline: ScheduleJob[];
  market: ScheduleJob[];
  session_read: ScheduleJob[];
}

export interface ExecSpec {
  program: string;
  script: string;
}

export function detectScheduleBackend(platform = process.platform): ScheduleBackend {
  if (platform === "darwin") return "launchd";
  if (platform === "win32") return "windows";
  return "systemd";
}

export function parseScheduleBackend(raw: string | undefined, platform = process.platform): ScheduleBackend {
  const value = raw === undefined || raw === "auto" || raw === "true" ? detectScheduleBackend(platform) : raw;
  if (value === "systemd" || value === "launchd" || value === "windows") return value;
  throw new Error(`backend_invalid:${raw}`);
}

export function parseSessionRuntime(raw: string | undefined): SessionRuntime {
  const value = raw === undefined || raw === "true" || raw === "auto" ? "both" : raw;
  if (value === "grok" || value === "claude" || value === "both") return value;
  throw new Error(`runtime_invalid:${raw}`);
}

export function buildSchedulePlan(cfg: RadarConfig, platform = process.platform): SchedulePlan {
  const pipeline: ScheduleJob[] = [
    { id: "collect", class: "wall_clock", command: "collect", local_times: [cfg.schedule.collect1, cfg.schedule.collect2], after: [], readiness: "schedulable" },
    { id: "score", class: "wall_clock", command: "score", local_times: [cfg.schedule.score], after: ["collect"], readiness: "schedulable" },
    { id: "card", class: "wall_clock", command: "card", local_times: [cfg.schedule.freeze, cfg.schedule.send], after: ["collect", "score"], readiness: "schedulable" },
  ];
  const market: ScheduleJob[] = [
    { id: "market-analyze", class: "wall_clock", command: "market analyze", local_times: [MARKET_WALL_CLOCK.analyze], after: [], readiness: "schedulable" },
    { id: "market-brief", class: "wall_clock", command: "market brief build", local_times: [MARKET_WALL_CLOCK.brief], after: ["market-analyze"], readiness: "schedulable" },
    { id: "market-observe", class: "wall_clock", command: "market observe", local_times: [], after: [], readiness: "planned" },
  ];
  const session_read: ScheduleJob[] = [
    { id: "morning-read", class: "session_read", command: "doctor && edition show latest && market brief show", local_times: ["09:00"], after: ["card"], readiness: "schedulable" },
    { id: "reach-watch", class: "session_read", command: "agent-reach watch", local_times: ["09:05"], after: [], readiness: "schedulable" },
  ];
  return { spec: "radar.schedule.plan.v1", backend_auto: detectScheduleBackend(platform), pipeline, market, session_read };
}
