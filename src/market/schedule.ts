// Advisory schedule constants for the market pipeline (openspec
// radar-scheduler-retirement-v1). Radar generates, writes, and installs no
// OS units: wall-clock wiring is a customer-side action
// (docs/runtime/schedule.md), and overlapping triggers serialize on the CLI
// run lock (src/runlock.ts).
//
// Design §5: the market pipeline runs stages separate from the legacy
// collect/score/card morning block, ordinary reads never trigger collection,
// failures are bounded, and a source task that misses its cutoff freezes a
// partial brief instead of blocking the edition.

export const MARKET_OBSERVE_POLICY = {
  // Two observation slots per day, 12h apart (local time).
  slots_per_day: 2,
  slot_spacing_hours: 12,
  // Bounded read-only collection per source.
  source_timeout_ms: 60_000,
  max_read_retries: 2,
  retry_backoff_ms: [2_000, 8_000],
  global_concurrency: 2,
  // Login failures / captcha never auto-retry; risk control cools down 24h.
  risk_control_cooldown_hours: 24,
} as const;

// Local times stay clear of the legacy collect/score/card morning block so
// the two schedules never fight over the shared SQLite lock.
export const MARKET_SCHEDULE_TIMES = { analyze: "08:50", brief: "09:00" } as const;

// Optional customer-side hook for the PG archive sync (radar market sync
// --to pg). Sync is manual by default and outside cutoff/freeze semantics —
// a late sync only means the archive replica lags, never that the SQLite
// source is affected. The owner MAY wire their own timer after market-brief,
// e.g. a cron line:
//
//   0 9:10 * * *  flock -w 600 $HOME/.short-drama-radar/radar.lock \
//     radar market sync --to pg --json
//
// RADAR_PG_URL belongs in the user environment or a user-level config file,
// never in a shared script or unit body.
export const MARKET_SCHEDULE_SYNC_HOOK = {
  command: "radar market sync --to pg",
  runs_after: "market brief build",
  generated: false,
  enabled: false,
  note: "Optional owner hook: Radar generates no units and no sync timer; the owner wires their own customer-side timer after market-brief. Sync is outside cutoff/freeze semantics — a late sync only leaves the archive replica behind.",
} as const;
