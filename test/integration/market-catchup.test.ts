import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { openDb } from "../../src/db/client.ts";
import { initializeMarket, updateSettings } from "../../src/market/sources.ts";
import { importCatalog } from "../../src/market/catalog.ts";
import { analyzeMarket } from "../../src/market/signals.ts";
import { catchUp } from "../../src/market/catchup.ts";
import { changeReadState, readReader } from "../../src/market/reader.ts";

test("catch-up paginates without read side effects and invalidates stale reader or policy cursors", async () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    await importCatalog(db, { source: "dramabox", content: readFileSync("test/fixtures/market/dramabox.md", "utf8"),
      format: "markdown", observedAt: "2026-09-10T08:00:00Z", origin: "fixture" });
    analyzeMarket(db, "2026-09-10T00:00:00Z", "2026-09-11T00:00:00Z");
    const now = new Date("2026-09-13T08:00:00Z");
    const first = catchUp(db, { limit: 1, now });
    expect(first.signals).toHaveLength(1);
    expect(first.next_cursor).not.toBeNull();
    const decoded = JSON.parse(Buffer.from(first.next_cursor!, "base64url").toString("utf8"));
    const forge = (patch: Record<string, unknown>) => Buffer.from(JSON.stringify({ ...decoded, ...patch })).toString("base64url");
    expect(() => catchUp(db, { cursor: forge({ start: "2025-01-01T00:00:00.000Z" }), now })).toThrow("cursor is invalid");
    expect(() => catchUp(db, { cursor: forge({ start: "2026-09-01T00:00:00.000Z", end: "2026-09-14T00:00:00.000Z" }), now })).toThrow("future");
    expect(() => catchUp(db, { cursor: forge({ ref: "../unsafe" }), now })).toThrow("cursor is invalid");
    const second = catchUp(db, { cursor: first.next_cursor!, now });
    expect(second.signals).toHaveLength(1);
    expect(second.signals[0].signal_ref).not.toBe(first.signals[0].signal_ref);
    expect(second.next_cursor).toBeNull();
    expect(readReader(db).revision).toBe(1);
    const item = first.signals[0];
    changeReadState(db, { action: "mark", idempotency_key: "read-first", expected_revision: 1,
      policy_revision: first.policy_revision, signals: [{ ref: item.signal_ref, revision: item.revision }] });
    expect(() => catchUp(db, { cursor: first.next_cursor!, now })).toThrow("restart catch-up");
    expect(catchUp(db, { now }).signals.map(s => s.signal_ref)).toEqual(second.signals.map(s => s.signal_ref));
    updateSettings(db, 1, { blocked_topics: ["taboo"] });
    expect(catchUp(db, { now }).signals).toEqual([]);
    expect(catchUp(db, { now: new Date("2026-11-01T08:00:00Z") }).signals).toEqual([]);
    expect(() => catchUp(db, { cursor: "not-valid" })).toThrow("cursor is invalid");
  } finally { db.$client.close(); }
});
