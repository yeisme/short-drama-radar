import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { openDb } from "../../src/db/client.ts";
import { initializeMarket, updateSettings } from "../../src/market/sources.ts";
import { importCatalog } from "../../src/market/catalog.ts";
import { analyzeMarket } from "../../src/market/signals.ts";
import { changeReadState, isRead, readerReceipt, readReader } from "../../src/market/reader.ts";
import { buildMarketBrief, readMarketBrief } from "../../src/market/brief.ts";

test("explicit reader writes are atomic, idempotent and revision-scoped; reading never marks content", async () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    await importCatalog(db, { source: "dramabox", content: readFileSync("test/fixtures/market/dramabox.md", "utf8"),
      format: "markdown", observedAt: "2026-09-10T08:00:00Z", origin: "fixture" });
    const analysis = analyzeMarket(db, "2026-09-10T00:00:00Z", "2026-09-11T00:00:00Z");
    buildMarketBrief(db, "2026-09-10T00:00:00Z", "2026-09-11T00:00:00Z", new Date("2026-09-11T08:00:00Z"));
    const signal = analysis.signals[0], other = analysis.signals[1];
    const reader = readReader(db);
    readMarketBrief(db);
    expect(readReader(db)).toEqual(reader);
    expect(isRead(db, signal)).toBe(false);
    const input = { action: "mark" as const, idempotency_key: "mark-1",
      expected_revision: reader.revision, policy_revision: reader.policy_revision, signals: [signal] };
    const receipt = changeReadState(db, input);
    expect(changeReadState(db, input)).toEqual(receipt);
    expect(readerReceipt(db, "mark-1")).toEqual(receipt);
    expect(isRead(db, signal)).toBe(true);
    expect(isRead(db, other)).toBe(false);
    expect(isRead(db, { ...signal, revision: 2 })).toBe(false);
    expect(() => changeReadState(db, { ...input, signals: [other] })).toThrow("different parameters");
    expect(() => changeReadState(db, { ...input, idempotency_key: "stale" })).toThrow("state");
    const current = readReader(db);
    expect(() => changeReadState(db, { ...input, expected_revision: current.revision,
      idempotency_key: "invalid", signals: [other, { ref: "missing", revision: 1 }] })).toThrow("does not exist");
    expect(isRead(db, other)).toBe(false);
    expect(readReader(db).revision).toBe(current.revision);
    changeReadState(db, { ...input, action: "unread", expected_revision: current.revision, idempotency_key: "undo-1" });
    expect(isRead(db, signal)).toBe(false);
    const oldPolicy = readReader(db);
    updateSettings(db, 1, { blocked_topics: ["taboo"] });
    expect(() => changeReadState(db, { ...input, expected_revision: oldPolicy.revision,
      policy_revision: oldPolicy.policy_revision, idempotency_key: "old-policy" })).toThrow("policy changed");
  } finally { db.$client.close(); }
});
