import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { openDb } from "../../src/db/client.ts";
import { opportunities, readingJudgments } from "../../src/db/schema.ts";
import { buildEdition } from "../../src/pipeline/edition.ts";
import { ProfileService } from "../../src/profile/service.ts";
import {
  JudgmentConsumerError,
  evaluateReadingJudgment,
  parseJudgmentMode,
  showReadingJudgment,
  type JudgmentMode,
} from "../../src/judgment/consumer.ts";
import { createFixtureTransport, fixtureCapabilities } from "../../src/judgment/transport.ts";
import { initializeMarket, registerSourceCandidate } from "../../src/market/sources.ts";
import { importCatalog } from "../../src/market/catalog.ts";
import { listChineseReading } from "../../src/market/translation.ts";

// radar-reading-judgment-v1 task 1.2 — the optional SDK consumer: default
// off with zero calls, injected fixture transport, one evaluate per explicit
// attempt, no automatic resend of unknown outcomes, and zero-network replay.

const databases: ReturnType<typeof openDb>[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.$client.close()));

function editionDb() {
  const db = openDb(":memory:");
  databases.push(db);
  const date = "2026-09-21";
  for (const [i, row] of [
    { topic: "revenge", hook: "identity_reversal", ref: "opp-revenge" },
    { topic: "sweet_romance", hook: "secret_reveal", ref: "opp-romance" },
  ].entries()) {
    db.insert(opportunities).values({
      ref: row.ref, date, clusterKey: `${row.topic}|${row.hook}|default`, topic: row.topic, hookFamily: row.hook,
      format: "default", marketScore: 70 + i, evidenceConfidence: 80, degraded: 0, crossPlatform: 0,
      evidenceDigest: `sha256:${row.ref}`, sourceRefsJson: JSON.stringify([`douyin:${row.ref}`]),
      builderVersion: "opportunity-builder.v1", createdAt: "2026-09-21T00:00:00.000Z",
    }).run();
  }
  const svc = new ProfileService(db);
  const profile = svc.create("consumer", { topics: [{ tag: "revenge", weight: 90 }], minimum_confidence: 30, minimum_fit: 30 });
  buildEdition(db, profile, date);
  return { db, profileRef: profile.ref };
}

async function readingDb() {
  const db = openDb(":memory:");
  databases.push(db);
  initializeMarket(db);
  registerSourceCandidate(db, { source_ref: "reelshort-ja", publisher_group: "reelshort", locale: "ja", markets: ["JP"] });
  await importCatalog(db, { source: "reelshort-ja", content: readFileSync("test/fixtures/market/reelshort-ja-fields.html", "utf8"), format: "html", observedAt: "2026-09-17T00:00:00Z", origin: "fixture" });
  expect(listChineseReading(db, { language: "zh-Hans" }).items.length).toBeGreaterThan(0);
  return db;
}

describe("modes", () => {
  test("default off; shadow and assist are explicit opt-ins", () => {
    expect(parseJudgmentMode(undefined)).toBe<JudgmentMode>("off");
    expect(parseJudgmentMode("off")).toBe<JudgmentMode>("off");
    expect(parseJudgmentMode("shadow")).toBe<JudgmentMode>("shadow");
    expect(parseJudgmentMode("assist")).toBe<JudgmentMode>("assist");
    expect(() => parseJudgmentMode("auto")).toThrow(JudgmentConsumerError);
    expect(() => parseJudgmentMode("live")).toThrow(/explicit opt-in/);
  });

  test("off mode makes no transport calls and writes nothing", async () => {
    const { db } = editionDb();
    const transport = createFixtureTransport();
    const outcome = await evaluateReadingJudgment(db, { mode: "off", transport, target: { kind: "edition" } });
    expect(outcome.outcome).toBe("off");
    expect(outcome.record).toBeNull();
    expect(transport.calls.describe).toBe(0);
    expect(transport.calls.evaluate).toBe(0);
    expect(db.select().from(readingJudgments).all()).toHaveLength(0);
  });
});

describe("assist evaluation through the injected fixture transport", () => {
  test("one describe + one evaluate, advisory suggestions, sanitized record", async () => {
    const { db } = editionDb();
    const transport = createFixtureTransport({ scenario: "answered" });
    const outcome = await evaluateReadingJudgment(db, { mode: "assist", transport, target: { kind: "edition" } });
    expect(outcome.outcome).toBe("evaluated");
    expect(transport.calls.describe).toBe(1);
    expect(transport.calls.evaluate).toBe(1);
    const record = outcome.record!;
    expect(record.spec).toBe("radar.reading_judgment.v1");
    expect(record.mode).toBe("assist");
    expect(record.execution_status).toBe("succeeded");
    expect(record.model.resolved_model).toBe("fixture-reading-judge.0");
    expect(record.suggestions.length).toBeGreaterThan(0);
    expect(record.suggestions.every((s) => s.adoptable && s.advisory_only)).toBe(true);
    // Wire contract shape: snake_case, schema 1.0, explicit pair binding.
    const request = transport.requests[0]!;
    expect(request.schema_version).toBe("1.0");
    expect(request.questions.map((q) => q.question_id).sort()).toEqual(["morning_relevance", "needs_verification", "reading_duplicate"]);
    for (const question of request.questions) {
      expect(question.candidate_ids.length).toBe(request.candidates.length);
    }
    // The stored record carries digests, bindings and answers — never the
    // inline source texts the model saw (owner-side topic/hook labels in
    // bindings are fine; prose from the projection is not).
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("inline_text");
    expect(serialized).not.toContain("morning-edition entry"); // inline candidate text
    expect(serialized).not.toContain("watch-concerns ("); // inline shared source text
    expect(serialized).not.toContain("peer-list ("); // inline peer source text
    // Baseline comparison exists and preserves the original ordering.
    expect(record.baseline?.kind).toBe("deterministic_order");
    expect(record.baseline?.baseline_order.length).toBeGreaterThan(0);
    // A missing-capability confidence stays null; nothing is invented.
    expect(record.items.every((i) => i.confidence === null && i.probability_true === null)).toBe(true);
  });

  test("replay is zero-call; a fresh attempt is the only way to re-submit", async () => {
    const { db } = editionDb();
    const transport = createFixtureTransport();
    const first = await evaluateReadingJudgment(db, { mode: "assist", transport, target: { kind: "edition" } });
    const second = await evaluateReadingJudgment(db, { mode: "assist", transport, target: { kind: "edition" } });
    expect(second.outcome).toBe("replayed");
    expect(second.record!.attempt_key).toBe(first.record!.attempt_key);
    expect(transport.calls.evaluate).toBe(1); // replay never re-submits
    const third = await evaluateReadingJudgment(db, { mode: "assist", transport, target: { kind: "edition" }, fresh: true });
    expect(third.outcome).toBe("evaluated");
    expect(third.record!.attempt_key).not.toBe(first.record!.attempt_key);
    expect(transport.calls.evaluate).toBe(2);
    expect(showReadingJudgment(db, first.record!.attempt_key)!.attempt_key).toBe(first.record!.attempt_key);
  });

  test("reading-list target evaluates through the same seam", async () => {
    const db = await readingDb();
    const transport = createFixtureTransport();
    const outcome = await evaluateReadingJudgment(db, { mode: "shadow", transport, target: { kind: "reading", language: "zh-Hans" } });
    expect(outcome.outcome).toBe("evaluated");
    expect(outcome.record!.target.kind).toBe("reading");
    expect(outcome.record!.suggestions.every((s) => s.binding_kind === "reading_item")).toBe(true);
    expect(outcome.record!.suggestions.every((s) => s.handoff.surface === "reading_list")).toBe(true);
  });
});

describe("safe failure classes", () => {
  test("unknown outcome never auto-resends; replay then explicit fresh attempt", async () => {
    const { db } = editionDb();
    const transport = createFixtureTransport({ scenario: "unknown-outcome" });
    const first = await evaluateReadingJudgment(db, { mode: "assist", transport, target: { kind: "edition" } });
    expect(first.outcome).toBe("failed");
    expect(first.record!.execution_status).toBe("unknown");
    expect(first.record!.error).toMatchObject({ code: "outcome_unknown", submission_state: "unknown", retry_class: "reconcile_first" });
    expect(first.record!.suggestions).toHaveLength(0);
    // Re-running the same evaluation replays the stored unknown outcome —
    // there is no automatic retry or model switch.
    const retry = await evaluateReadingJudgment(db, { mode: "assist", transport, target: { kind: "edition" } });
    expect(retry.outcome).toBe("replayed");
    expect(transport.calls.evaluate).toBe(1);
    const fresh = await evaluateReadingJudgment(db, { mode: "assist", transport, target: { kind: "edition" }, fresh: true });
    expect(fresh.record!.attempt_key).not.toBe(first.record!.attempt_key);
    expect(transport.calls.evaluate).toBe(2);
  });

  test("unavailable transport fails closed before submission", async () => {
    const { db } = editionDb();
    const transport = createFixtureTransport({ scenario: "unavailable" });
    const outcome = await evaluateReadingJudgment(db, { mode: "shadow", transport, target: { kind: "edition" } });
    expect(outcome.record!.execution_status).toBe("failed");
    expect(outcome.record!.error).toMatchObject({ code: "unavailable", submission_state: "not_submitted", retry_class: "safe_before_submit" });
  });

  test("a malformed result (missing pair) is rejected as invalid_response", async () => {
    const { db } = editionDb();
    const transport = createFixtureTransport({ scenario: "malformed-pair" });
    const outcome = await evaluateReadingJudgment(db, { mode: "assist", transport, target: { kind: "edition" } });
    expect(outcome.record!.execution_status).toBe("failed");
    expect(outcome.record!.error!.code).toBe("invalid_response");
    expect(outcome.record!.suggestions).toHaveLength(0);
  });

  test("required abstention blocks adoption without failing the record", async () => {
    const { db } = editionDb();
    const transport = createFixtureTransport({ scenario: "abstain-required" });
    const outcome = await evaluateReadingJudgment(db, { mode: "assist", transport, target: { kind: "edition" } });
    expect(outcome.record!.execution_status).toBe("succeeded");
    for (const suggestion of outcome.record!.suggestions) {
      expect(suggestion.adoptable).toBe(false);
      expect(suggestion.blockers).toContain("required_answer_missing:morning_relevance");
      expect(suggestion.blockers).toContain("required_answer_missing:needs_verification");
    }
  });

  test("capability precheck rejects unsupported primitives and schemas before any evaluate", async () => {
    const { db } = editionDb();
    const capabilities = fixtureCapabilities();
    capabilities.models = capabilities.models.map((m) => ({ ...m, primitives: ["choice"] })); // binary unsupported
    const transport = {
      ...createFixtureTransport(),
      describeCapabilities: async () => capabilities,
    };
    const outcome = await evaluateReadingJudgment(db, { mode: "assist", transport, target: { kind: "edition" } });
    expect(outcome.record!.error!.code).toBe("unsupported_capability");
    expect(transport.calls.evaluate).toBe(0);
  });
});
