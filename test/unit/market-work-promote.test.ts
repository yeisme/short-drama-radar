import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { openDb } from "../../src/db/client.ts";
import { initializeMarket } from "../../src/market/sources.ts";
import { importCatalog } from "../../src/market/catalog.ts";
import { workMapping, workSubjectRef } from "../../src/market/identity.ts";
import { evaluateAndRecordGate, promoteWork } from "../../src/market/gate.ts";
import { analyzeMarket } from "../../src/market/signals.ts";
import { MarketStoreError } from "../../src/market/repository.ts";
import { marketWorkGateDecisions } from "../../src/db/schema.ts";

const fields = () => readFileSync("test/fixtures/market/hongguo-fields.html", "utf8");
const withEpisode = workSubjectRef("hongguo", "7574794690361297951");
const noEpisode = workSubjectRef("hongguo", "7574794690361297950");

async function seed(db: ReturnType<typeof openDb>) {
  initializeMarket(db);
  await importCatalog(db, { source: "hongguo", content: fields(), format: "html", observedAt: "2026-09-10T08:00:00Z", origin: "manual" });
  await importCatalog(db, { source: "hongguo", content: fields(), format: "html", observedAt: "2026-09-11T08:00:00Z", origin: "manual" });
}

test("promote requires an operative promotable decision and leaves rejected works candidate (S06)", async () => {
  const db = openDb(":memory:");
  try {
    await seed(db);
    const ready = workMapping(db, withEpisode)!;
    try {
      promoteWork(db, { work: withEpisode, expected_revision: ready.mapping_revision, canonical_work_ref: "canonical-1", evidence_refs: ready.supporting_evidence_refs });
      throw new Error("expected gate_not_passed");
    } catch (error) { expect((error as MarketStoreError).code).toBe("gate_not_passed"); }
    evaluateAndRecordGate(db, noEpisode, { kind: "single" }, new Date("2026-09-12T08:00:00Z"));
    const blocked = workMapping(db, noEpisode)!;
    try {
      promoteWork(db, { work: noEpisode, expected_revision: blocked.mapping_revision, canonical_work_ref: "canonical-blocked", evidence_refs: blocked.supporting_evidence_refs });
      throw new Error("expected gate_not_passed");
    } catch (error) {
      expect((error as MarketStoreError).code).toBe("gate_not_passed");
      expect((error as MarketStoreError).message).toContain("field_coverage_below_floor");
    }
    expect(workMapping(db, noEpisode)?.mapping_status).toBe("candidate");
    evaluateAndRecordGate(db, withEpisode, { kind: "single" }, new Date("2026-09-12T08:00:00Z"));
    const promoted = promoteWork(db, {
      work: withEpisode, expected_revision: ready.mapping_revision,
      canonical_work_ref: "canonical-1", evidence_refs: ready.supporting_evidence_refs,
    }, new Date("2026-09-12T09:00:00Z"));
    expect(promoted.mapping.mapping_status).toBe("verified");
    expect(promoted.mapping.canonical_work_ref).toBe("canonical-1");
    expect(promoted.mapping.mapping_revision).toBe(ready.mapping_revision + 1);
    expect(promoted.overridden).toBe(false);
    expect(workMapping(db, withEpisode)?.mapping_status).toBe("verified");
  } finally { db.$client.close(); }
});

test("override records an auditable decision and canonical change revises signals (S06/S08)", async () => {
  const db = openDb(":memory:");
  try {
    await seed(db);
    analyzeMarket(db, "2026-09-10T00:00:00Z", "2026-09-12T00:00:00Z");
    const blocked = workMapping(db, noEpisode)!;
    const overridden = promoteWork(db, {
      work: noEpisode, expected_revision: blocked.mapping_revision,
      canonical_work_ref: "canonical-override", evidence_refs: blocked.supporting_evidence_refs,
      override_reason: "owner accepts missing episode count for this catalog sample",
    }, new Date("2026-09-12T10:00:00Z"));
    expect(overridden.overridden).toBe(true);
    expect(overridden.mapping.mapping_status).toBe("verified");
    const overrideRow = db.select().from(marketWorkGateDecisions).all()
      .map(row => row.payload).find(decision => decision.overridden);
    expect(overrideRow?.override_reason).toContain("missing episode count");
    expect(overrideRow?.reason_codes).toContain("field_coverage_below_floor");
    const second = promoteWork(db, {
      work: noEpisode, expected_revision: overridden.mapping.mapping_revision,
      canonical_work_ref: "canonical-override-2", evidence_refs: overridden.mapping.supporting_evidence_refs,
      override_reason: "relabel canonical after a later identity review",
    }, new Date("2026-09-12T11:00:00Z"));
    expect(second.identity_changed).toBe(true);
    expect(second.signal_revisions.length).toBeGreaterThan(0);
    expect(workMapping(db, noEpisode)?.canonical_work_ref).toBe("canonical-override-2");
    expect(workMapping(db, noEpisode)?.mapping_status).toBe("verified");
  } finally { db.$client.close(); }
});
