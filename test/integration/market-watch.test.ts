import { expect, test } from "bun:test";
import { openDb } from "../../src/db/client.ts";
import { preferenceFeedback, marketReadMarks } from "../../src/db/schema.ts";
import { initializeMarket, updateSettings } from "../../src/market/sources.ts";
import { importCatalog } from "../../src/market/catalog.ts";
import { analyzeMarket, signalByRef } from "../../src/market/signals.ts";
import { readFileSync } from "node:fs";
import { readReader } from "../../src/market/reader.ts";
import { listWatches, mutateWatch, watchReceipt } from "../../src/market/watch.ts";

test("watch lifecycle and replay do not mutate creative feedback or read marks", () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    const reader = readReader(db);
    const input = { action: "add" as const, key: "add-watch", revision: reader.revision,
      policy_revision: reader.policy_revision, kind: "platform" as const, target: "hongguo" };
    const added = mutateWatch(db, input);
    expect(added.watch.state).toBe("active");
    expect(mutateWatch(db, input)).toEqual(added);
    expect(watchReceipt(db, input.key)).toEqual(added);
    expect(() => mutateWatch(db, { ...input, target: "dramabox" })).toThrow("different parameters");
    expect(() => mutateWatch(db, { ...input, key: "stale" })).toThrow("Reader or policy changed");
    for (const action of ["pause", "resume", "remove"] as const) {
      const current = readReader(db);
      const result = mutateWatch(db, { action, key: action, revision: current.revision,
        policy_revision: current.policy_revision, watch: added.watch.watch_ref });
      expect(result.watch.state).toBe(action === "pause" ? "paused" : action === "resume" ? "active" : "removed");
    }
    expect(listWatches(db)).toHaveLength(1);
    expect(listWatches(db)[0].revision).toBe(4);
    expect(db.select().from(preferenceFeedback).all()).toEqual([]);
    expect(db.select().from(marketReadMarks).all()).toEqual([]);
    const current = readReader(db);
    expect(() => mutateWatch(db, { ...input, revision: current.revision, key: "unknown",
      kind: "market", target: "ZZ" })).toThrow("not in the observation registry");
  } finally { db.$client.close(); }
});

test.each(["topic", "work"] as const)("current policy protects %s watch lists, receipts and replay without changing history", async kind => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    await importCatalog(db, { source: "dramabox", content: readFileSync("test/fixtures/market/dramabox.md", "utf8"),
      format: "markdown", observedAt: "2026-09-10T08:00:00Z", origin: "fixture" });
    const signals = analyzeMarket(db, "2026-09-10T00:00:00Z", "2026-09-11T00:00:00Z");
    const target = kind === "topic" ? "revenge" : signalByRef(db, signals.signals[0].ref)!.subject_ref;
    const reader = readReader(db);
    const input = { action: "add" as const, key: "policy-watch", revision: reader.revision,
      policy_revision: reader.policy_revision, kind, target };
    const added = mutateWatch(db, input);
    updateSettings(db, 1, { blocked_topics: ["revenge"] });
    expect(listWatches(db)).toEqual([]);
    expect(() => watchReceipt(db, input.key)).toThrow("blocked or unclassified");
    expect(() => mutateWatch(db, input)).toThrow("blocked or unclassified");
    const current = readReader(db);
    expect(() => mutateWatch(db, { action: "resume", key: "blocked-resume", revision: current.revision,
      policy_revision: current.policy_revision, watch: added.watch.watch_ref })).toThrow("blocked or unclassified");
    expect(readReader(db)).toEqual(current);
    updateSettings(db, 2, { blocked_topics: [] });
    expect(listWatches(db)).toEqual([added.watch]);
    expect(watchReceipt(db, input.key)).toEqual(added);
    expect(watchReceipt(db, "blocked-resume")).toBeNull();
  } finally { db.$client.close(); }
});

test("personal JP and KR watches remain independent and do not fabricate feedback", () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    const added = ["JP", "KR"].map(target => {
      const reader = readReader(db);
      return mutateWatch(db, { action: "add", key: `personal-${target}`, revision: reader.revision,
        policy_revision: reader.policy_revision, kind: "market", target });
    });
    expect(new Set(added.map(r => r.watch.watch_ref)).size).toBe(2);
    const current = readReader(db);
    mutateWatch(db, { action: "pause", key: "pause-jp-only", revision: current.revision,
      policy_revision: current.policy_revision, watch: added[0]!.watch.watch_ref });
    const watches = listWatches(db);
    expect(watches.find(w => w.target_ref === "JP")!.state).toBe("paused");
    expect(watches.find(w => w.target_ref === "KR")!.state).toBe("active");
    expect(db.select().from(preferenceFeedback).all()).toEqual([]);
    expect(db.select().from(marketReadMarks).all()).toEqual([]);
  } finally { db.$client.close(); }
});
