import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { openDb } from "../../src/db/client.ts";
import { initializeMarket } from "../../src/market/sources.ts";
import { importCatalog } from "../../src/market/catalog.ts";
import { refreshWorkCandidate, workMapping, workSubjectRef } from "../../src/market/identity.ts";
import {
  CURRENT_GATE_VERSION, evaluateAndRecordGate, evaluateWorkGate, latestGateDecision, operativeGateDecision,
  promoteWork, recordGateDecision,
} from "../../src/market/gate.ts";
import { MarketStoreError } from "../../src/market/repository.ts";
import { marketWorkGateDecisions } from "../../src/db/schema.ts";

const fields = () => readFileSync("test/fixtures/market/hongguo-fields.html", "utf8");
const withEpisode = workSubjectRef("hongguo", "7574794690361297951");

async function seedPromotable(db: ReturnType<typeof openDb>) {
  initializeMarket(db);
  await importCatalog(db, { source: "hongguo", content: fields(), format: "html", observedAt: "2026-09-10T08:00:00Z", origin: "manual" });
  await importCatalog(db, { source: "hongguo", content: fields(), format: "html", observedAt: "2026-09-11T08:00:00Z", origin: "manual" });
}

test("decisions are immutable, replays reuse, and a new evaluation mints a new ref (S02)", async () => {
  const db = openDb(":memory:");
  try {
    await seedPromotable(db);
    const first = evaluateAndRecordGate(db, withEpisode, { kind: "single" }, new Date("2026-09-12T08:00:00Z"));
    expect(first.reused).toBe(false);
    expect(first.decision.verdict).toBe("promotable");
    const replay = recordGateDecision(db, evaluateWorkGate(db, withEpisode), { kind: "single" }, "2026-09-12T08:00:00Z");
    expect(replay.reused).toBe(true);
    expect(replay.decision.decision_ref).toBe(first.decision.decision_ref);
    expect(db.select().from(marketWorkGateDecisions).all()).toHaveLength(1);
    const later = evaluateAndRecordGate(db, withEpisode, { kind: "single" }, new Date("2026-09-12T09:00:00Z"));
    expect(later.reused).toBe(false);
    expect(later.decision.decision_ref).not.toBe(first.decision.decision_ref);
    expect(later.decision.gate_version).toBe(CURRENT_GATE_VERSION);
    expect(operativeGateDecision(db, withEpisode)?.decision_ref).toBe(later.decision.decision_ref);
  } finally { db.$client.close(); }
});

test("operative decision dies with a new mapping revision; promote names stale_gate_decision (S06)", async () => {
  const db = openDb(":memory:");
  try {
    await seedPromotable(db);
    const recorded = evaluateAndRecordGate(db, withEpisode, { kind: "single" }, new Date("2026-09-12T08:00:00Z"));
    const head = workMapping(db, withEpisode)!;
    expect(operativeGateDecision(db, withEpisode)?.decision_ref).toBe(recorded.decision.decision_ref);
    refreshWorkCandidate(db, withEpisode, head.original_title + " alias-refresh", head.supporting_evidence_refs[0]!);
    expect(workMapping(db, withEpisode)!.mapping_revision).toBe(head.mapping_revision + 1);
    expect(operativeGateDecision(db, withEpisode)).toBeNull();
    expect(latestGateDecision(db, withEpisode)?.decision_ref).toBe(recorded.decision.decision_ref);
    try {
      promoteWork(db, {
        work: withEpisode, expected_revision: head.mapping_revision + 1,
        canonical_work_ref: "canonical-stale", evidence_refs: head.supporting_evidence_refs,
      });
      throw new Error("expected stale_gate_decision");
    } catch (error) {
      expect((error as MarketStoreError).code).toBe("stale_gate_decision");
    }
    expect(workMapping(db, withEpisode)!.mapping_status).toBe("candidate");
    expect(db.select().from(marketWorkGateDecisions).all()).toHaveLength(1);
  } finally { db.$client.close(); }
});
