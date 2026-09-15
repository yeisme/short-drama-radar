import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { openDb } from "../../src/db/client.ts";
import { marketBatches, marketObservations } from "../../src/db/schema.ts";
import { initializeMarket } from "../../src/market/sources.ts";
import { observeCatalog } from "../../src/market/observe.ts";
import { marketCommand } from "../../src/market/cli.ts";
import { MarketStoreError, saveSource, sourceByRef } from "../../src/market/repository.ts";
import { importCatalog } from "../../src/market/catalog.ts";

const fields = () => readFileSync("test/fixtures/market/hongguo-fields.html", "utf8");
const fixtureDir = "test/fixtures";

function flags(entries: Record<string, string[]>): Map<string, string[]> {
  return new Map(Object.entries(entries));
}

test("verify-sample fixture observe writes fixture origin and never mints live", async () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    const receipt = await observeCatalog(db, {
      source: "hongguo", mode: "verify-sample", fixture: true, fixtureDir,
      observedAt: "2026-09-10T08:00:00Z",
    });
    expect(receipt.origin).toBe("fixture");
    expect(receipt.items).toBe(4);
    expect(receipt.readiness_unchanged).toBe("planned");
    expect(db.select().from(marketBatches).all().every(row => row.origin === "fixture")).toBe(true);
  } finally { db.$client.close(); }
});

test("observe without authorization or with a non-hongguo source fails closed", async () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    await expect(observeCatalog(db, { source: "hongguo", mode: "verify-sample" }))
      .rejects.toMatchObject({ code: "owner_authorization_required" });
    await expect(observeCatalog(db, { source: "reelshort", mode: "verify-sample", confirmLive: true }))
      .rejects.toMatchObject({ code: "source_unsupported" });
    await expect(observeCatalog(db, { source: "hongguo", mode: "production", confirmLive: true, fetchImpl: async () => new Response("{}") }))
      .rejects.toMatchObject({ code: "qualification_required" });
    await expect(marketCommand(["market", "observe"], flags({ source: ["hongguo"], mode: ["verify-sample"] }), db))
      .rejects.toMatchObject({ code: "owner_authorization_required" });
  } finally { db.$client.close(); }
});

test("confirm-live scrape stores live origin without promoting readiness", async () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    const html = fields();
    const receipt = await observeCatalog(db, {
      source: "hongguo", mode: "verify-sample", confirmLive: true,
      observedAt: "2026-09-14T08:00:00Z",
      fetchImpl: async () => new Response(JSON.stringify({ data: { rawHtml: html } }), { headers: { "content-type": "application/json" } }),
    });
    expect(receipt.origin).toBe("live");
    expect(receipt.readiness_unchanged).toBe("planned");
    expect(sourceByRef(db, "hongguo")?.readiness).toBe("planned");
    expect(db.select().from(marketObservations).all().every(row => row.origin === "live")).toBe(true);
    expect(JSON.stringify(db.select().from(marketObservations).all())).not.toContain("<html");
  } finally { db.$client.close(); }
});

test("empty catalog scrape is source_unavailable with zero writes", async () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    await expect(observeCatalog(db, {
      source: "hongguo", mode: "verify-sample", confirmLive: true,
      observedAt: "2026-09-14T08:00:00Z",
      fetchImpl: async () => new Response(JSON.stringify({ data: { rawHtml: "<html><body>请登录</body></html>" } })),
    })).rejects.toMatchObject({ code: "source_unavailable" });
    expect(db.select().from(marketBatches).all()).toHaveLength(0);
  } finally { db.$client.close(); }
});

test("production observe is allowed after sample_verified and import still cannot mint live", async () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    const current = sourceByRef(db, "hongguo")!;
    saveSource(db, { ...current, revision: 2, readiness: "sample_verified",
      official_identity_evidence: ["evidence-identity-hongguo"] }, 1);
    const receipt = await observeCatalog(db, {
      source: "hongguo", mode: "production", confirmLive: true,
      observedAt: "2026-09-14T12:00:00Z",
      fetchImpl: async () => new Response(JSON.stringify({ data: { rawHtml: fields() } })),
    });
    expect(receipt.origin).toBe("live");
    expect(receipt.mode).toBe("production");
    await expect(importCatalog(db, {
      source: "hongguo", content: fields(), format: "html",
      observedAt: "2026-09-14T13:00:00Z", origin: "live",
    })).rejects.toMatchObject({ code: "origin_invalid" });
  } finally { db.$client.close(); }
});
