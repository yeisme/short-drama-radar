import { join } from "node:path";
import type { RadarConfig } from "./config.ts";
import { buildSchedulePlan, execSpecFromStart, parseHHMM, unitRadarHome, xmlEscape, type ExecSpec, type ScheduleJob } from "./schedule-plan.ts";

export interface LaunchdUnits {
  [fileName: string]: string;
}

export function launchdUserDir(home: string): string {
  return join(home, "Library", "LaunchAgents");
}

// launchd never expands `~` or `%h` and StandardOutPath/EnvironmentVariables
// must be absolute: a literal `~` path either fails to write logs or points
// the scheduled job at a different database than interactive runs. The
// caller's home (or an explicit RADAR_HOME) is embedded absolutely.
export function buildLaunchdUnits(cfg: RadarConfig, execStart: string, home: string): LaunchdUnits {
  const plan = buildSchedulePlan(cfg);
  const exec = execSpecFromStart(execStart);
  const radarHome = unitRadarHome(home);
  const units: LaunchdUnits = {};
  for (const job of plan.pipeline) units[plistName(job.id)] = renderPlist(job, exec, radarHome);
  return units;
}

export const LAUNCHD_NEXT_STEPS = [
  "launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.yeisme.short-drama-radar.collect.plist",
  "launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.yeisme.short-drama-radar.score.plist",
  "launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.yeisme.short-drama-radar.card.plist",
  "launchctl print gui/$UID/com.yeisme.short-drama-radar.collect",
];

function plistName(id: string): string {
  return `com.yeisme.short-drama-radar.${id}.plist`;
}

function renderPlist(job: ScheduleJob, exec: ExecSpec, radarHome: string): string {
  const label = `com.yeisme.short-drama-radar.${job.id}`;
  const args = [exec.program, exec.script, ...job.command.split(" "), "--json"].filter((a) => a.length > 0);
  const intervals = job.local_times.map((t) => {
    const { hour, minute } = parseHHMM(t);
    return `    <dict>\n      <key>Hour</key><integer>${hour}</integer>\n      <key>Minute</key><integer>${minute}</integer>\n    </dict>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n")}
  </array>
  <key>StartCalendarInterval</key>
  <array>
${intervals.join("\n")}
  </array>
  <key>RunAtLoad</key>
  <false/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(`${join(radarHome, "logs")}/${job.id}.out.log`)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(`${join(radarHome, "logs")}/${job.id}.err.log`)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>RADAR_HOME</key>
    <string>${xmlEscape(radarHome)}</string>
  </dict>
</dict>
</plist>
`;
}
