import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { openDb } from "../../src/db/client.ts";
import { initializeMarket } from "../../src/market/sources.ts";
import { importCatalog } from "../../src/market/catalog.ts";
import { workSubjectRef } from "../../src/market/identity.ts";
import {
  CURRENT_GATE_VERSION, GATE_REASON_CODES, evaluateWorkGate, gateRuleSet, parseGateRuleSet, WORK_INGESTION_GATE_SPEC,
} from "../../src/market/gate.ts";
import { MarketStoreError } from "../../src/market/repository.ts";

const fields = () => readFileSync("test/fixtures/market/hongguo-fields.html", "utf8");
const withEpisode = workSubjectRef("hongguo", "7574794690361297951");
const noEpisode = workSubjectRef("hongguo", "7574794690361297950");
const noCategory = workSubjectRef("hongguo", "7574794690361297999");

async function seed(db: ReturnType<typeof openDb>, origin: "fixture" | "manual", times: string[], content = fields(), format: "html" | "markdown" = "html") {
  initializeMarket(db);
  const receipts = [];
  for (const observedAt of times) {
    receipts.push(await importCatalog(db, { source: "hongguo", content, format, observedAt, origin }));
  }
  return receipts;
}

test("rule set contract rejects illegal payloads and unknown reason codes (S01/S03)", () => {
  const current = gateRuleSet(CURRENT_GATE_VERSION);
  expect(current.spec).toBe(WORK_INGESTION_GATE_SPEC);
  expect(current.rules.map(r => r.rule_id)).toEqual([
    "stable_identity", "alias_reconciliation", "required_field_coverage", "evidence_floor",
  ]);
  expect(parseGateRuleSet(current)).toEqual(current);
  expect(current.field_set).toBe("catalog-fields.v2");
  expect(gateRuleSet("work-ingestion-gate-rules.v1").field_set).toBe("catalog-fields.v1");
  expect(gateRuleSet("work-ingestion-gate-rules.v1").required_fields).toEqual(["title", "episode_count"]);
  const invalid = [
    { ...current, spec: "nope" },
    { ...current, rules: current.rules.slice(0, 3) },
    { ...current, rules: current.rules.map((r, i) => i ? r : { ...r, failure_reasons: ["not_a_reason"] }) },
    { ...current, required_fields: [] },
    { ...current, min_identity_batches: 1 },
  ];
  for (const value of invalid) {
    expect(() => parseGateRuleSet(value)).toThrow(MarketStoreError);
  }
  try { parseGateRuleSet({ ...current, rules: current.rules.map((r, i) => i ? r : { ...r, failure_reasons: ["not_a_reason"] }) }); }
  catch (error) { expect((error as MarketStoreError).code).toBe("gate_rules_invalid"); }
  try { gateRuleSet("work-ingestion-gate-rules.v9"); }
  catch (error) {
    expect((error as MarketStoreError).code).toBe("gate_version_unknown");
    expect((error as MarketStoreError).message).toContain("work-ingestion-gate-rules.v1");
  }
  expect(GATE_REASON_CODES).toContain("fixture_only_evidence");
});

test("evaluate is deterministic and names fixture-only, identity, and coverage failures (S03/S04/S10)", async () => {
  const db = openDb(":memory:");
  try {
    await seed(db, "fixture", ["2026-09-10T08:00:00Z", "2026-09-11T08:00:00Z"]);
    const fixture = evaluateWorkGate(db, withEpisode);
    expect(fixture.verdict).toBe("rejected");
    expect(fixture.reason_codes).toContain("fixture_only_evidence");
    expect(evaluateWorkGate(db, withEpisode)).toEqual(fixture);
    expect(evaluateWorkGate(db, withEpisode, "work-ingestion-gate-rules.v2")).toEqual(fixture);
  } finally { db.$client.close(); }

  const once = openDb(":memory:");
  try {
    await seed(once, "manual", ["2026-09-10T08:00:00Z"]);
    const single = evaluateWorkGate(once, withEpisode);
    expect(single.reason_codes).toContain("identity_not_corroborated");
    expect(single.rule_results.find(r => r.rule_id === "stable_identity")?.detail).toMatchObject({ batches: 1 });
  } finally { once.$client.close(); }

  const covered = openDb(":memory:");
  try {
    await seed(covered, "manual", ["2026-09-10T08:00:00Z", "2026-09-11T08:00:00Z"]);
    const ready = evaluateWorkGate(covered, withEpisode);
    expect(ready.verdict).toBe("promotable");
    expect(ready.reason_codes).toEqual([]);
    const missing = evaluateWorkGate(covered, noEpisode);
    expect(missing.reason_codes).toContain("field_coverage_below_floor");
    expect(missing.rule_results.find(r => r.rule_id === "required_field_coverage")?.detail.missing).toEqual(["episode_count"]);
  } finally { covered.$client.close(); }
});

test("Lane A field set v2 requires category while v1 decisions stay on catalog-fields.v1 (S10)", async () => {
  const db = openDb(":memory:");
  try {
    const markdown = "[无类目剧·全80集](https://novelquickapp.com/detail?series_id=7574794690361297999)\n";
    await seed(db, "manual", ["2026-09-10T08:00:00Z", "2026-09-11T08:00:00Z"], markdown, "markdown");
    const v1 = evaluateWorkGate(db, noCategory, "work-ingestion-gate-rules.v1");
    const v2 = evaluateWorkGate(db, noCategory, "work-ingestion-gate-rules.v2");
    expect(v1.verdict).toBe("promotable");
    expect(v1.rule_results.find(r => r.rule_id === "required_field_coverage")?.detail.field_set).toBe("catalog-fields.v1");
    expect(v2.verdict).toBe("rejected");
    expect(v2.reason_codes).toEqual(["field_coverage_below_floor"]);
    expect(v2.rule_results.find(r => r.rule_id === "required_field_coverage")?.detail).toMatchObject({
      field_set: "catalog-fields.v2", missing: ["category"],
    });
  } finally { db.$client.close(); }
});
