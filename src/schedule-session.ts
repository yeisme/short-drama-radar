import type { SessionRuntime } from "./schedule-plan.ts";

export interface SessionPlanJob {
  id: string;
  kind: "session_read";
  interval: "1d";
  claude_cron: string;
  grok_loop: string;
  claude_loop: string;
  prompt: string;
  scheduler_create: { interval: "1d"; prompt: string; durable: false; fire_immediately: false };
}

export interface SessionPlan {
  spec: "radar.schedule.session_plan.v1";
  runtime: SessionRuntime;
  jobs: SessionPlanJob[];
  limitations: string[];
}

const LIMITATIONS = [
  "Session loops are not wall-clock 08:10 collect. Install systemd, launchd, or Windows tasks for morning collection.",
  "Grok /loop uses intervals (1d), expires after 7 days, and runs a detached subagent that cannot see this conversation.",
  "Claude /loop lives in the current session and stops when that session ends.",
  "Claude Scheduled Tasks (research preview) use isolated sessions and cron; they still require the Claude runtime and do not replace OS timers.",
  "These prompts are read-only. They must not run radar collect, radar run, or market observe --confirm-live.",
];

const MORNING_PROMPT = [
  "You are a Radar session watcher. Do not collect live data, do not change Profile, and do not print cookies or secrets.",
  "From the short-drama-radar project (or PATH radar) run:",
  "radar doctor --json",
  "radar edition show latest --json",
  "radar market brief show --json",
  "Report status, degraded/empty reasons, evidence refs, and the single next real command.",
  "If a command fails, quote error.code and stop; do not retry live collection.",
].join(" ");

const WATCH_PROMPT = [
  "You are checking Agent Reach health for the Radar operator. Do not log in, do not export cookies, and do not post.",
  "If agent-reach is on PATH, run: agent-reach watch",
  "Report only problem or update lines (failed/warn/new-version). If the binary is missing, say so and stop.",
].join(" ");

export function buildSessionPlan(runtime: SessionRuntime = "both"): SessionPlan {
  const all: SessionPlanJob[] = [
    sessionJob("morning-read", "0 9 * * *", MORNING_PROMPT),
    sessionJob("reach-watch", "5 9 * * *", WATCH_PROMPT),
  ];
  return {
    spec: "radar.schedule.session_plan.v1",
    runtime,
    jobs: all,
    limitations: [...LIMITATIONS],
  };
}

export function sessionPlanActions(plan: SessionPlan): { name: string; command: string }[] {
  const jobs = plan.jobs;
  const actions: { name: string; command: string }[] = [];
  if (plan.runtime === "grok" || plan.runtime === "both") {
    for (const job of jobs) actions.push({ name: `grok-${job.id}`, command: job.grok_loop });
  }
  if (plan.runtime === "claude" || plan.runtime === "both") {
    for (const job of jobs) actions.push({ name: `claude-loop-${job.id}`, command: job.claude_loop });
  }
  return actions;
}

function sessionJob(id: string, claudeCron: string, prompt: string): SessionPlanJob {
  return {
    id,
    kind: "session_read",
    interval: "1d",
    claude_cron: claudeCron,
    grok_loop: `/loop 1d ${prompt}`,
    claude_loop: `/loop 1d ${prompt}`,
    prompt,
    scheduler_create: { interval: "1d", prompt, durable: false, fire_immediately: false },
  };
}
