import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Cross-process run lock for mutating pipeline commands. Wall-clock
// scheduling is customer-owned (cron / launchd / Task Scheduler / agent
// runtimes), so the serialization the retired generated units used to get
// from `flock -w 600` now lives in the CLI itself. Same lock file path as
// those units used: owners who still wrap calls in flock keep working, and
// every other trigger gets the guarantee for free.

export const RUN_LOCK_FILE = "radar.lock";
export const DEFAULT_LOCK_WAIT_MS = 600_000; // matches the retired `flock -w 600`
const MAX_WAIT_MS = 3_600_000;
const POLL_MS = 250;

export interface RunLock {
  path: string;
  release: () => void;
}

export interface LockHolder {
  pid: number;
  command: string;
  startedAt: string;
}

export class RunLockBusyError extends Error {
  constructor(public readonly holder: LockHolder) {
    super(`run lock held by pid ${holder.pid} (${holder.command}) since ${holder.startedAt}`);
    this.name = "RunLockBusyError";
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readHolder(path: string): LockHolder | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LockHolder>;
    if (typeof parsed.pid !== "number") return null;
    return {
      pid: parsed.pid,
      command: String(parsed.command ?? "unknown"),
      startedAt: String(parsed.startedAt ?? "unknown"),
    };
  } catch {
    return null; // unreadable lock bodies are treated as stale
  }
}

function lockWaitMs(): number {
  const raw = Number(process.env.RADAR_LOCK_WAIT_MS);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_LOCK_WAIT_MS;
  return Math.min(raw, MAX_WAIT_MS);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function releaseIfOwned(path: string, body: string): void {
  try {
    if (readFileSync(path, "utf8") === body) unlinkSync(path);
  } catch {
    // Already gone or replaced by a stealing process — nothing to do.
  }
}

export async function acquireRunLock(home: string, command: string, timeoutMs = lockWaitMs()): Promise<RunLock> {
  mkdirSync(home, { recursive: true });
  const path = join(home, RUN_LOCK_FILE);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const body = JSON.stringify({ pid: process.pid, command, startedAt: new Date().toISOString() });
    try {
      writeFileSync(path, body, { flag: "wx" });
      return { path, release: () => releaseIfOwned(path, body) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const holder = readHolder(path);
    if (!holder || !pidAlive(holder.pid)) {
      try {
        unlinkSync(path); // stale or unreadable: take over
      } catch {
        // Raced against a steal/create; retry the exclusive create.
      }
      continue;
    }
    if (Date.now() >= deadline) throw new RunLockBusyError(holder);
    await sleep(Math.min(POLL_MS, Math.max(1, deadline - Date.now())));
  }
}

// One-shot probe for `radar doctor`: never waits, never steals.
export function probeRunLock(home: string): { status: "ok" } | { status: "busy"; holder: LockHolder } {
  const path = join(home, RUN_LOCK_FILE);
  const body = JSON.stringify({ pid: process.pid, command: "doctor:probe", startedAt: new Date().toISOString() });
  try {
    writeFileSync(path, body, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const holder = readHolder(path);
    if (holder && pidAlive(holder.pid)) return { status: "busy", holder };
    return { status: "ok" }; // stale lock body: a real command would take over
  }
  releaseIfOwned(path, body);
  return { status: "ok" };
}
