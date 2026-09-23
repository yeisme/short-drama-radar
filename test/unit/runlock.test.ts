import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireRunLock, probeRunLock, RunLockBusyError, RUN_LOCK_FILE } from "../../src/runlock.ts";

// The run lock replaces the flock discipline the retired generated units
// used to provide: scheduling is customer-owned, so overlapping triggers
// must queue (or fail loudly) inside the CLI itself.

describe("run lock (radar-scheduler-retirement-v1)", () => {
  function home(): string {
    return mkdtempSync(join(tmpdir(), "radar-lock-"));
  }

  test("acquire creates the lock and release removes it", async () => {
    const dir = home();
    const lock = await acquireRunLock(dir, "radar run");
    const path = join(dir, RUN_LOCK_FILE);
    expect(existsSync(path)).toBe(true);
    expect((JSON.parse(readFileSync(path, "utf8")) as { pid: number }).pid).toBe(process.pid);
    lock.release();
    expect(existsSync(path)).toBe(false);
  });

  test("a live holder makes the second acquire fail with holder info", async () => {
    const dir = home();
    const first = await acquireRunLock(dir, "radar run");
    const started = Date.now();
    let busy: unknown;
    try {
      await acquireRunLock(dir, "radar collect", 150);
    } catch (err) {
      busy = err;
    }
    expect(busy).toBeInstanceOf(RunLockBusyError);
    expect((busy as RunLockBusyError).holder.pid).toBe(process.pid);
    expect((busy as RunLockBusyError).holder.command).toBe("radar run");
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    first.release();
  });

  test("a waiting acquire proceeds once the holder releases", async () => {
    const dir = home();
    const first = await acquireRunLock(dir, "radar run");
    const second = acquireRunLock(dir, "radar score", 5_000);
    await new Promise((r) => setTimeout(r, 250));
    first.release();
    const lock = await second; // must resolve after the release, not time out
    lock.release();
  });

  test("a dead holder's stale lock is taken over", async () => {
    const dir = home();
    writeFileSync(join(dir, RUN_LOCK_FILE), JSON.stringify({ pid: 999_999_999, command: "radar collect", startedAt: "2026-09-23T00:00:00Z" }));
    const lock = await acquireRunLock(dir, "radar run", 0);
    expect((JSON.parse(readFileSync(join(dir, RUN_LOCK_FILE), "utf8")) as { pid: number }).pid).toBe(process.pid);
    lock.release();
  });

  test("release never removes a lock that was stolen", async () => {
    const dir = home();
    const path = join(dir, RUN_LOCK_FILE);
    const mine = await acquireRunLock(dir, "radar run");
    // Someone else (stale takeover) replaced the body while we ran.
    writeFileSync(path, JSON.stringify({ pid: 424_242, command: "other", startedAt: "2026-09-23T00:00:00Z" }));
    mine.release();
    expect(existsSync(path)).toBe(true);
    expect((JSON.parse(readFileSync(path, "utf8")) as { pid: number }).pid).toBe(424_242);
  });

  test("doctor probe is read-only: ok on free, busy on held, never steals", async () => {
    const dir = home();
    expect(probeRunLock(dir)).toEqual({ status: "ok" });
    expect(existsSync(join(dir, RUN_LOCK_FILE))).toBe(false);
    const held = await acquireRunLock(dir, "radar run");
    const probe = probeRunLock(dir);
    if (probe.status === "busy") {
      expect(probe.holder.pid).toBe(process.pid);
      expect(existsSync(join(dir, RUN_LOCK_FILE))).toBe(true); // untouched
    } else {
      throw new Error("expected busy probe while the lock is held");
    }
    held.release();
  });
});
