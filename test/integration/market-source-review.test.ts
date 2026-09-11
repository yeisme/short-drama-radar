import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { openDb } from "../../src/db/client.ts";
import { initializeMarket } from "../../src/market/sources.ts";
import { importCatalog } from "../../src/market/catalog.ts";
import { reviewSource, sourceReviewReceipt } from "../../src/market/source-review.ts";
import { recordSamplingCheck } from "../../src/market/sampling.ts";
import { sourceByRef } from "../../src/market/repository.ts";
import { marketCommand } from "../../src/market/cli.ts";

test("owner source review preserves revisions, rejects fixtures and requires checked samples", async () => {
  const db = openDb(":memory:");
  const now = new Date("2026-09-11T08:00:00Z");
  try {
    initializeMarket(db);
    const content = readFileSync("test/fixtures/market/dramabox.md", "utf8");
    const fixture = await importCatalog(db, { source: "dramabox", content, format: "markdown", origin: "fixture", observedAt: "2026-09-09T08:00:00Z" });
    const input = { key: "identity-review", source_ref: "dramabox", revision: 1, stage: "identity" as const,
      reason: "Synthetic owner identity review for contract testing.", evidence_refs: ["evidence-" + fixture.observation_refs[0]] };
    expect(() => reviewSource(db, input, now)).toThrow("non-fixture evidence");
    expect(sourceByRef(db, "dramabox")!.revision).toBe(1);
    // Manual input simulates owner-provided evidence; it never becomes live collection.
    const manual = await importCatalog(db, { source: "dramabox", content, format: "markdown", origin: "manual", observedAt: "2026-09-09T08:00:00Z" });
    const identityInput = { ...input, evidence_refs: ["evidence-" + manual.observation_refs[0]] };
    const verified = reviewSource(db, identityInput, now);
    expect(verified.receipt.source.readiness).toBe("identity_verified");
    expect(reviewSource(db, identityInput, now).reused).toBe(true);
    expect(() => reviewSource(db, { ...identityInput, reason: "Changed reason" }, now)).toThrow("different parameters");
    const sample = await importCatalog(db, { source: "dramabox", content, format: "markdown", origin: "manual", observedAt: "2026-09-10T08:00:00Z" });
    const sampleInput = { ...identityInput, key: "sample-review", revision: 2, stage: "sample" as const,
      batch_ref: sample.batch_ref, evidence_refs: ["evidence-" + sample.observation_refs[0]] };
    expect(() => reviewSource(db, sampleInput, now)).toThrow("complete ID/metric checks");
    recordSamplingCheck(db, { batch_ref: sample.batch_ref, scheduled_at: "2026-09-10T08:00:00Z", checked_at: "2026-09-10T09:00:00Z",
      completeness: "complete", stable_ids: true, metric_contract_valid: true, failure_sample_ref: sampleInput.evidence_refs[0] }, now);
    const sampled = reviewSource(db, sampleInput, now);
    expect(sampled.receipt.source.readiness).toBe("sample_verified");
    expect(sampled.receipt.source.revision).toBe(3);
    expect(sourceByRef(db, "dramabox", 1)!.readiness).toBe("planned");
    expect(sourceReviewReceipt(db, "identity-review")).toEqual(verified.receipt);
    const blocked = await marketCommand(["market", "source", "review"], new Map(Object.entries({
      source: ["dramabox"], revision: ["3"], stage: ["blocked"], reason: ["Source currently unavailable."], key: ["blocked-review"],
    })), db);
    expect(blocked.status).toBe("success");
    expect(sourceByRef(db, "dramabox")!.readiness).toBe("blocked");
    expect(() => reviewSource(db, { ...sampleInput, key: "stale-review" }, now)).toThrow("current source revision");
  } finally { db.$client.close(); }
});
