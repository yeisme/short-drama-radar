import { join } from "node:path";
import type { RadarConfig } from "./config.ts";
import { buildSchedulePlan, execSpecFromStart, parseHHMM, xmlEscape, type ExecSpec, type ScheduleJob } from "./schedule-plan.ts";

export interface WindowsUnits {
  [fileName: string]: string;
}

export function windowsTaskDir(home: string, localAppData = process.env.LOCALAPPDATA): string {
  return join(localAppData && localAppData.length > 0 ? localAppData : join(home, "AppData", "Local"), "short-drama-radar", "tasks");
}

export function buildWindowsUnits(cfg: RadarConfig, execStart: string): WindowsUnits {
  const plan = buildSchedulePlan(cfg);
  const exec = execSpecFromStart(execStart);
  const units: WindowsUnits = {};
  for (const job of plan.pipeline) units[`short-drama-radar-${job.id}.xml`] = renderTaskXml(job, exec);
  return units;
}

export const WINDOWS_NEXT_STEPS = [
  'schtasks /Create /TN "short-drama-radar-collect" /XML "%LOCALAPPDATA%\\short-drama-radar\\tasks\\short-drama-radar-collect.xml" /F',
  'schtasks /Create /TN "short-drama-radar-score" /XML "%LOCALAPPDATA%\\short-drama-radar\\tasks\\short-drama-radar-score.xml" /F',
  'schtasks /Create /TN "short-drama-radar-card" /XML "%LOCALAPPDATA%\\short-drama-radar\\tasks\\short-drama-radar-card.xml" /F',
  'schtasks /Query /TN "short-drama-radar-collect" /FO LIST /V',
];

function renderTaskXml(job: ScheduleJob, exec: ExecSpec): string {
  const triggers = job.local_times.map((t) => {
    const { hour, minute } = parseHHMM(t);
    const hh = String(hour).padStart(2, "0");
    const mm = String(minute).padStart(2, "0");
    return `    <CalendarTrigger>
      <StartBoundary>2020-01-01T${hh}:${mm}:00</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
    </CalendarTrigger>`;
  });
  const command = xmlEscape(exec.program);
  const argumentsLine = xmlEscape([exec.script, ...job.command.split(" "), "--json"].filter((a) => a.length > 0).join(" "));
  return `<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>short-drama-radar: ${xmlEscape(job.id)} (generated; do not edit by hand)</Description>
  </RegistrationInfo>
  <Triggers>
${triggers.join("\n")}
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${command}</Command>
      <Arguments>${argumentsLine}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}
