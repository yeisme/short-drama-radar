import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { openDb } from "../../src/db/client.ts";
import { initializeMarket } from "../../src/market/sources.ts";
import { importCatalog } from "../../src/market/catalog.ts";
import { reviewWorkBatch, reviewBatchReceipt } from "../../src/market/review-batch.ts";
import { MarketStoreError } from "../../src/market/repository.ts";
import { marketWorkGateDecisions } from "../../src/db/schema.ts";

const fields = () => readFileSync("test/fixtures/market/hongguo-fields.html", "utf8");

test("review-batch is transactional, empty-range legal, and idempotent by key (S05/S07)", async () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    const empty = reviewWorkBatch(db, { source_ref: "hongguo", key: "empty-1" });
    expect(empty.receipt.evaluated).toBe(0);
    expect(empty.receipt.promotable).toBe(0);
    expect(empty.reused).toBe(false);
    try { reviewWorkBatch(db, { source_ref: "not-a-source", key: "missing-source" }); throw new Error("expected source_not_found"); }
    catch (error) { expect((error as MarketStoreError).code).toBe("source_not_found"); }
    expect(reviewBatchReceipt(db, "empty-1")?.evaluated).toBe(0);

    await importCatalog(db, { source: "hongguo", content: fields(), format: "html", observedAt: "2026-09-10T08:00:00Z", origin: "manual" });
    await importCatalog(db, { source: "hongguo", content: fields(), format: "html", observedAt: "2026-09-11T08:00:00Z", origin: "manual" });
    const first = reviewWorkBatch(db, { source_ref: "hongguo", key: "hongguo-1" });
    expect(first.receipt.evaluated).toBe(4);
    expect(first.receipt.promotable).toBe(2);
    expect(first.receipt.rejected).toBe(2);
    expect(first.receipt.decision_refs).toHaveLength(4);
    const decisions = db.select().from(marketWorkGateDecisions).all().length;
    const replay = reviewWorkBatch(db, { source_ref: "hongguo", key: "hongguo-1" });
    expect(replay.reused).toBe(true);
    expect(replay.receipt.decision_refs).toEqual(first.receipt.decision_refs);
    expect(db.select().from(marketWorkGateDecisions).all()).toHaveLength(decisions);
    try { reviewWorkBatch(db, { source_ref: "reelshort", key: "hongguo-1" }); throw new Error("expected idempotency_conflict"); }
    catch (error) { expect((error as MarketStoreError).code).toBe("idempotency_conflict"); }
    expect(reviewBatchReceipt(db, "hongguo-1")?.payload_digest).toBe(first.receipt.payload_digest);
    const narrowed = reviewWorkBatch(db, { source_ref: "hongguo", batch_ref: (await importCatalog(db, {
      source: "hongguo", content: fields(), format: "html", observedAt: "2026-09-10T08:00:00Z", origin: "manual",
    })).batch_ref, key: "hongguo-batch" });
    expect(narrowed.receipt.evaluated).toBe(4);
  } finally { db.$client.close(); }
});
