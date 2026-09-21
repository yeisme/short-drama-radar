import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { openDb, type RadarDb } from "../../src/db/client.ts";
import { opportunities, preferenceFeedback, readingJudgments } from "../../src/db/schema.ts";
import { buildEdition, latestEdition } from "../../src/pipeline/edition.ts";
import { ProfileService } from "../../src/profile/service.ts";
import { evaluateReadingJudgment } from "../../src/judgment/consumer.ts";
import { JudgmentAdoptionError, acceptReadingSuggestion, readingJudgmentEvidence } from "../../src/judgment/evidence.ts";
import { createFixtureTransport } from "../../src/judgment/transport.ts";
import { initializeMarket, registerSourceCandidate, updateSettings } from "../../src/market/sources.ts";
import { importCatalog } from "../../src/market/catalog.ts";
import { listChineseReading } from "../../src/market/translation.ts";
import { marketReadPolicy } from "../../src/market/policy.ts";

// radar-reading-judgment-v1 task 1.3 — adoption hands off to the original
// review flow after re-verification; stale sources, revoked permissions and
// incomplete answers can never be adopted, and evaluation executes nothing.

const databases: ReturnType<typeof openDb>[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.$client.close()));

function editionDb() {
  const db = openDb(":memory:");
  databases.push(db);
  initializeMarket(db);
  const date = "2026-09-21";
  for (const [i, row] of [
    { topic: "revenge", hook: "identity_reversal", ref: "opp-revenge" },
  ].entries()) {
    db.insert(opportunities).values({
      ref: row.ref, date, clusterKey: `${row.topic}|${row.hook}|default`, topic: row.topic, hookFamily: row.hook,
      format: "default", marketScore: 70 + i, evidenceConfidence: 80, degraded: 0, crossPlatform: 0,
      evidenceDigest: `sha256:${row.ref}`, sourceRefsJson: JSON.stringify([`douyin:${row.ref}`]),
      builderVersion: "opportunity-builder.v1", createdAt: "2026-09-21T00:00:00.000Z",
    }).run();
  }
  const svc = new ProfileService(db);
  const profile = svc.create("adopt", { topics: [{ tag: "revenge", weight: 90 }], minimum_confidence: 30, minimum_fit: 30 });
  buildEdition(db, profile, date);
  return { db, svc, profileRef: profile.ref };
}

async function evaluate(db: RadarDb, mode: "assist" | "shadow" = "assist", scenario: "answered" | "abstain-required" | "unknown-outcome" = "answered") {
  return evaluateReadingJudgment(db, { mode, transport: createFixtureTransport({ scenario }), target: { kind: "edition" } });
}

describe("adoption through the original feedback flow", () => {
  test("assist + fresh + fully answered adopts via addFeedback and records review refs", async () => {
    const { db } = editionDb();
    const outcome = await evaluate(db);
    const record = outcome.record!;
    const candidate = record.suggestions[0]!;
    const accepted = acceptReadingSuggestion(db, { attempt_key: record.attempt_key, candidate_id: candidate.candidate_id, kind: "not_relevant" });
    expect(accepted.executed).toBe(true);
    if (!accepted.executed) return;
    expect(accepted.surface).toBe("edition_feedback");
    expect(accepted.receipt.kind).toBe("not_relevant");
    expect(accepted.receipt.duplicate).toBe(false);
    // The business write went through the existing feedback ledger.
    const rows = db.select().from(preferenceFeedback).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.opportunityRef).toBe(candidate.ref);
    // Evidence records the review handoff; a second adoption is stale.
    const evidence = readingJudgmentEvidence(db, record.attempt_key);
    expect(evidence.review.accepted?.kind).toBe("not_relevant");
    expect(() => acceptReadingSuggestion(db, { attempt_key: record.attempt_key, candidate_id: candidate.candidate_id, kind: "used" }))
      .toThrow(JudgmentAdoptionError);
    // The edition itself is untouched (immutable record, no judgment fields).
    const edition = latestEdition(db, record.bindings.authorization.profile_ref!)!;
    expect(Object.keys(edition)).not.toContain("accepted");
    expect(edition.entries[0]!.opportunityRef).toBe(candidate.ref);
  });

  test("shadow, failed executions and abstained required answers never adopt", async () => {
    const shadowDb = editionDb();
    const shadow = await evaluate(shadowDb.db, "shadow");
    expect(() => acceptReadingSuggestion(shadowDb.db, {
      attempt_key: shadow.record!.attempt_key,
      candidate_id: shadow.record!.suggestions[0]!.candidate_id,
      kind: "saved",
    })).toThrow(/Shadow-mode/);

    const unknownDb = editionDb();
    const unknown = await evaluate(unknownDb.db, "assist", "unknown-outcome");
    expect(() => acceptReadingSuggestion(unknownDb.db, {
      attempt_key: unknown.record!.attempt_key,
      candidate_id: "cand-1",
      kind: "saved",
    })).toThrow(/ended 'unknown'/);

    const abstainDb = editionDb();
    const abstained = await evaluate(abstainDb.db, "assist", "abstain-required");
    expect(() => acceptReadingSuggestion(abstainDb.db, {
      attempt_key: abstained.record!.attempt_key,
      candidate_id: abstained.record!.suggestions[0]!.candidate_id,
      kind: "saved",
    })).toThrow(/Required answers are missing/);
    expect(abstainDb.db.select().from(preferenceFeedback).all()).toHaveLength(0);
  });

  test("invalid review kinds are rejected — the human picks the outcome, not the model", async () => {
    const { db } = editionDb();
    const record = (await evaluate(db)).record!;
    expect(() => acceptReadingSuggestion(db, {
      attempt_key: record.attempt_key,
      candidate_id: record.suggestions[0]!.candidate_id,
      kind: "definitely_relevant",
    })).toThrow(/kind must be one of/);
  });
});

describe("stale and revoked suggestions cannot be adopted", () => {
  test("a profile revision after evaluation makes the attempt stale", async () => {
    const { db, svc, profileRef } = editionDb();
    const record = (await evaluate(db)).record!;
    svc.set(profileRef, { risk_tolerance: 55 }); // new immutable revision
    expect(() => acceptReadingSuggestion(db, {
      attempt_key: record.attempt_key,
      candidate_id: record.suggestions[0]!.candidate_id,
      kind: "saved",
    })).toThrow(/re-evaluate explicitly/);
    expect(db.select().from(preferenceFeedback).all()).toHaveLength(0);
  });

  test("a policy change after evaluation makes the attempt stale", async () => {
    const { db } = editionDb();
    const record = (await evaluate(db)).record!;
    updateSettings(db, 1, { blocked_topics: ["sweet_romance"] }); // any policy movement
    expect(() => acceptReadingSuggestion(db, {
      attempt_key: record.attempt_key,
      candidate_id: record.suggestions[0]!.candidate_id,
      kind: "saved",
    })).toThrow(/policy changed/);
  });

  test("a candidate whose topics became blocked is rejected without confirming content", async () => {
    const { db } = editionDb();
    const record = (await evaluate(db)).record!;
    // The staleness gate normally fires first (any blocked-topic change
    // moves the policy revision). Exercise the defense-in-depth permission
    // gate directly: rebind the stored record to the CURRENT policy revision
    // while the candidate topic is blocked, so only the permission check can
    // reject. The message must not reveal the blocked topic itself.
    updateSettings(db, 1, { blocked_topics: ["revenge"] });
    const payload = record;
    payload.bindings.authorization.market_policy_revision = marketReadPolicy(db).policy_revision;
    db.update(readingJudgments).set({ payload }).where(eq(readingJudgments.attemptKey, record.attempt_key)).run();
    expect(() => acceptReadingSuggestion(db, {
      attempt_key: record.attempt_key,
      candidate_id: record.suggestions[0]!.candidate_id,
      kind: "saved",
    })).toThrow(/not readable under the current policy/);
  });
});

describe("reading-list adoption stays a handoff, never an implicit execution", () => {
  test("accept returns handoff commands and leaves reader/translation state untouched", async () => {
    const db = openDb(":memory:");
    databases.push(db);
    initializeMarket(db);
    registerSourceCandidate(db, { source_ref: "reelshort-ja", publisher_group: "reelshort", locale: "ja", markets: ["JP"] });
    await importCatalog(db, { source: "reelshort-ja", content: readFileSync("test/fixtures/market/reelshort-ja-fields.html", "utf8"), format: "html", observedAt: "2026-09-17T00:00:00Z", origin: "fixture" });
    const before = listChineseReading(db, { language: "zh-Hans" });
    const outcome = await evaluateReadingJudgment(db, { mode: "assist", transport: createFixtureTransport(), target: { kind: "reading", language: "zh-Hans" } });
    const record = outcome.record!;
    const suggestion = record.suggestions[0]!;
    const accepted = acceptReadingSuggestion(db, { attempt_key: record.attempt_key, candidate_id: suggestion.candidate_id, kind: "already_seen" });
    expect(accepted.executed).toBe(false);
    if (accepted.executed) return;
    expect(accepted.handoff.commands.length).toBeGreaterThan(0);
    expect(accepted.handoff.commands.some((c) => c.startsWith("radar market"))).toBe(true);
    // No feedback rows, no translation writes, identical reading list.
    expect(db.select().from(preferenceFeedback).all()).toHaveLength(0);
    const after = listChineseReading(db, { language: "zh-Hans" });
    expect(after.items.map((i) => i.work_ref)).toEqual(before.items.map((i) => i.work_ref));
    // The market basis stays unknown in this fixture, so the market-brief
    // handoff is offered alongside the reading list.
    expect(record.suggestions.some((s) => s.handoff.commands.includes("radar market brief show"))).toBe(true);
  });
});

describe("sanitized evidence view", () => {
  test("carries refs, digests and review state; never source texts", async () => {
    const { db } = editionDb();
    const record = (await evaluate(db)).record!;
    const evidence = readingJudgmentEvidence(db, record.attempt_key);
    expect(evidence.spec).toBe("radar.reading_judgment_evidence.v1");
    expect(evidence.versions.question_set.digest).toBe(record.question_set.digest);
    expect(evidence.execution.status).toBe("succeeded");
    expect(evidence.review.advisory_only).toBe(true);
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain("inline_text");
    expect(serialized).not.toContain("watch-concerns (");
    // Old CLI envelopes stay compatible: the reading list projection gains no
    // judgment keys.
    expect(Object.keys(listChineseReading(db, { language: "zh-Hans" }))).toEqual(["spec", "language", "items", "truncated", "omitted", "limitations"]);
  });
});
