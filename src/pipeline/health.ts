import { and, eq, gte, lt, lte } from "drizzle-orm";
import type { RadarDb } from "../db/client.ts";
import { dailyItems, rawSnapshots, runs } from "../db/schema.ts";
import { existsSync, readFileSync } from "node:fs";

// Collection health report — the evidence generator for the 14-day
// collection validation. Reads only runs/raw_snapshots/daily_items receipts;
// no secrets, no raw payloads, safe for evidence dirs.

export interface DayHealth {
  date: string;
  collectAttempts: number;
  platformsCovered: string[]; // platforms with >=1 daily item
  items: number;
  snapshots: number;
  duplicateSnapshotRate: number; // snapshots that did not add a new daily item
  degraded: boolean; // any collect run degraded or any item degraded
  degradedLayers: string[];
  stableIdViolations: number; // daily rows whose content id is not a stable id shape
}

export interface AccountSurvival {
  configured: number;
  active: number;
  cooldown: number;
  disabled: number;
  byPlatform: Record<string, { configured: number; active: number; cooldown: number; disabled: number }>;
}

export interface HealthReport {
  windowDays: number;
  from: string;
  to: string;
  daysWithAttempt: number;
  daysWithCollection: number;
  degradedDays: number;
  coverageDays: { douyin: number; xiaohongshu: number; both: number };
  avgItemsPerDay: number;
  avgDuplicateRate: number;
  stableIdViolationTotal: number;
  accountSurvival: AccountSurvival;
  days: DayHealth[];
}

export function buildHealthReport(db: RadarDb, windowDays = 14, today = new Date(), accountsPath?: string): HealthReport {
  const to = today.toISOString().slice(0, 10);
  const fromDate = new Date(today.getTime() - (windowDays - 1) * 24 * 3600 * 1000);
  const from = fromDate.toISOString().slice(0, 10);

  // Window rows are filtered in SQL against indexed columns; raw_snapshots
  // timestamps are full ISO strings, so the exclusive upper bound is the day
  // after `to` (lexicographic compare on TEXT matches the date-part filter).
  const toExclusive = new Date(today.getTime() + 24 * 3600 * 1000).toISOString().slice(0, 10);
  const items = db.select().from(dailyItems)
    .where(and(gte(dailyItems.date, from), lte(dailyItems.date, to))).all();
  const snapshots = db.select().from(rawSnapshots)
    .where(and(gte(rawSnapshots.fetchedAt, from), lt(rawSnapshots.fetchedAt, toExclusive))).all();
  const runRows = db.select().from(runs).where(eq(runs.kind, "collect")).all();

  const byDate = new Map<string, DayHealth>();
  for (const item of items) {
    const day = byDate.get(item.date) ?? emptyDay(item.date);
    day.items++;
    day.platformsCovered = Array.from(new Set([...day.platformsCovered, item.platform]));
    if (item.degraded === 1) day.degraded = true;
    if (!isStableId(item.platform, item.contentId)) day.stableIdViolations++;
    byDate.set(item.date, day);
  }
  for (const snap of snapshots) {
    const date = snap.fetchedAt.slice(0, 10);
    const day = byDate.get(date) ?? emptyDay(date);
    day.snapshots++;
    byDate.set(date, day);
  }
  for (const run of runRows) {
    const date = run.startedAt.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? run.id.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? "";
    if (date < from || date > to) continue;
    const day = byDate.get(date) ?? emptyDay(date);
    day.collectAttempts++;
    if (run.status !== "ok") day.degraded = true;
    try {
      const summary = JSON.parse(run.summaryJson) as { degradedLayers?: string[] };
      day.degradedLayers = Array.from(new Set([...day.degradedLayers, ...(summary.degradedLayers ?? [])]));
    } catch {
      // malformed receipts are ignored; runs table stays append-only
    }
    byDate.set(date, day);
  }

  const days = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  for (const day of days) {
    // A snapshot "duplicate" is a re-fetch of an item already in that day's
    // set (expected across the two daily passes — reported, not treated as
    // an error until it dominates).
    day.duplicateSnapshotRate = day.snapshots === 0 ? 0 : round2(Math.max(0, day.snapshots - day.items) / day.snapshots);
  }
  const attempted = days.filter((d) => d.collectAttempts > 0 || d.items > 0 || d.snapshots > 0);
  const collected = days.filter((d) => d.items > 0 || d.snapshots > 0);
  return {
    windowDays,
    from,
    to,
    daysWithAttempt: attempted.length,
    daysWithCollection: collected.length,
    degradedDays: attempted.filter((d) => d.degraded).length,
    coverageDays: {
      douyin: attempted.filter((d) => d.platformsCovered.includes("douyin")).length,
      xiaohongshu: attempted.filter((d) => d.platformsCovered.includes("xiaohongshu")).length,
      both: attempted.filter((d) => d.platformsCovered.includes("douyin") && d.platformsCovered.includes("xiaohongshu")).length,
    },
    avgItemsPerDay: attempted.length === 0 ? 0 : round2(attempted.reduce((s, d) => s + d.items, 0) / attempted.length),
    avgDuplicateRate: collected.length === 0 ? 0 : round2(collected.reduce((s, d) => s + d.duplicateSnapshotRate, 0) / collected.length),
    stableIdViolationTotal: days.reduce((s, d) => s + d.stableIdViolations, 0),
    accountSurvival: readAccountSurvival(accountsPath),
    days,
  };
}

function emptyDay(date: string): DayHealth {
  return { date, collectAttempts: 0, platformsCovered: [], items: 0, snapshots: 0, duplicateSnapshotRate: 0, degraded: false, degradedLayers: [], stableIdViolations: 0 };
}

function readAccountSurvival(path?: string): AccountSurvival {
  const empty: AccountSurvival = { configured: 0, active: 0, cooldown: 0, disabled: 0, byPlatform: {} };
  if (!path || !existsSync(path)) return empty;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { accounts?: Array<{ platform?: string; status?: string }> };
    for (const account of raw.accounts ?? []) {
      if (!account.platform || !["active", "cooldown", "disabled"].includes(account.status ?? "")) continue;
      const platform = empty.byPlatform[account.platform] ?? { configured: 0, active: 0, cooldown: 0, disabled: 0 };
      platform.configured++;
      empty.configured++;
      const status = account.status as "active" | "cooldown" | "disabled";
      platform[status]++;
      empty[status]++;
      empty.byPlatform[account.platform] = platform;
    }
    return empty;
  } catch {
    return empty;
  }
}

// Stable id shapes per platform: douyin 19-digit ids, xhs 16+ hex digits.
// Anything else (e.g. hash fallbacks) counts as a violation to review.
export function isStableId(platform: string, contentId: string): boolean {
  if (platform === "douyin") return /^\d{6,10}$/.test(contentId) || /^\d{15,20}$/.test(contentId);
  // Hex ids must be 17-32 chars: the firecrawl URL-hash fallback is exactly
  // 16 hex chars and is NOT stable across runs, so that exact shape is a
  // reviewable violation, not a pass.
  return /^[0-9a-f]{17,32}$/.test(contentId) || /^\d{15,25}$/.test(contentId);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
