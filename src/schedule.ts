// Schedule surface for the customer-owned wiring era (openspec
// radar-scheduler-retirement-v1): Radar derives an advisory plan and
// read-only session projections. It generates, writes, and installs no OS
// units — wall-clock timers are customer-side (docs/runtime/schedule.md),
// and overlapping triggers serialize on the CLI run lock (src/runlock.ts).

export { buildSchedulePlan, detectScheduleBackend, parseScheduleBackend, parseSessionRuntime } from "./schedule-plan.ts";
export type { ScheduleBackend, SchedulePlan, SessionRuntime } from "./schedule-plan.ts";
export { buildSessionPlan, sessionPlanActions } from "./schedule-session.ts";
