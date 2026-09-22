import { join } from "node:path";
import type { RadarConfig } from "./config.ts";

// Keep in sync with MARKET_SCHEDULE_TIMES in market/schedule.ts without
// importing that module (it already imports the systemd helpers).
const MARKET_WALL_CLOCK = { analyze: "08:50", brief: "09:00" } as const;

// The RADAR_HOME pinned into generated schedule units. `%h` keeps the
// systemd default relocatable; an explicitly configured home is embedded
// absolutely so scheduled services and interactive commands hit the same
// database, lock and logs (a divergent home silently splits the store).
// launchd/Windows get no specifier: pass home and the result is absolute.
export function unitRadarHome(home?: string): string {
  const explicit = process.env.RADAR_HOME ?? "";
  if (explicit.length > 0) return explicit;
  return home ? join(home, ".short-drama-radar") : "%h/.short-drama-radar";
}

// Values needing no escaping keep the bare form (RADAR_HOME=%h/... must stay
// a specifier, not a literal); everything else is quoted and escaped.
export function systemdEnvironmentLine(name: string, value: string): string {
  const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
  return `Environment="${name}=${escaped}"`;
}

// Documented env overrides (see the CLI help "Env:" block) propagate into
// generated units when set; without them a scheduled collect/score/card runs
// against the default database while interactive commands use the
// configured one. Secrets (cookies, tokens) are never in this list.
export function propagatedScheduleEnv(): string[] {
  return ["FIRECRAWL_BASE_URL", "RADAR_DB_PATH", "RADAR_CONFIG_PATH", "RADAR_ACCOUNTS_PATH", "AGENT_REACH_BIN"]
    .filter((name) => (process.env[name] ?? "").length > 0)
    .map((name) => systemdEnvironmentLine(name, process.env[name]!));
}

export function radarHomeEnvironmentLine(radarHome: string): string {
  return radarHome.includes("%") ? `Environment=RADAR_HOME=${radarHome}` : systemdEnvironmentLine("RADAR_HOME", radarHome);
}

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

export function parseHHMM(time: string): { hour: number; minute: number } {
  const m = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) throw new Error(`time_invalid:${time}`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) throw new Error(`time_invalid:${time}`);
  return { hour, minute };
}

export function execSpecFromStart(execStart: string): ExecSpec {
  const trimmed = execStart.trim();
  const sp = trimmed.indexOf(" ");
  if (sp <= 0) return { program: trimmed, script: "" };
  return { program: trimmed.slice(0, sp), script: trimmed.slice(sp + 1).trim() };
}

export function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
