import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRequest } from "@yeisme/judgment-sdk";
import { openDb } from "../../src/db/client.ts";
import { opportunities, readingJudgments } from "../../src/db/schema.ts";
import { buildEdition } from "../../src/pipeline/edition.ts";
import { ProfileService } from "../../src/profile/service.ts";
import type { JudgmentRequest } from "../../src/judgment/contract.ts";
import { countReadingJudgments, evaluateReadingJudgment } from "../../src/judgment/consumer.ts";
import { PROJECTION_LIMITS, WIRE_ENVELOPE_HEADROOM_BYTES } from "../../src/judgment/projection.ts";
import { buildSdkWire } from "../../src/judgment/sdk-http.ts";
import { createFixtureTransport, type JudgmentTransport } from "../../src/judgment/transport.ts";
import { judgmentStatusCommand } from "../../src/judgment/cli.ts";

// Regression matrix for the sdk-http bridge and consumer evidence fixes:
// wire-cap headroom, ASCII id mapping, evaluate-call accounting, discovery
// failure classification, concurrent attempt keys, precheck replay and the
// status attempt count.

const DIGEST = `sha256:${"a".repeat(64)}`;
const CAPS_MODEL = { transportProvider: "sdk-http", modelProvider: "adapter", requestedModel: "test/model-1", responseModel: null, underlyingRevision: null, pinLevel: "router_model_id" as const, underlyingRevisionVerified: false };

function wireRequest(overrides: Partial<JudgmentRequest> = {}): JudgmentRequest {
  return {
    schema_version: "1.0",
    request_id: "rj-edition-test",
    attempt_id: "rj-edition-test-a1",
    scope: { owner: "radar", project: "reading-judgment", principal: "profile-integration" },
    model: { transport_provider: "injected", model_provider: "unresolved", requested_model: "declared-by-capabilities" },
    question_set: { id: "qs", version: "1.0.0", digest: DIGEST },
    policy_ref: { id: "pol", version: "1.0.0", digest: DIGEST },
    sources: [{ source_id: "douyin:synthetic-0", revision: 3, digest: DIGEST, inline_text: "line", language: "zh-Hans" }],
    candidates: [{ candidate_id: "cand-1", source_ids: ["douyin:synthetic-0"] }],
    questions: [{
      question_id: "morning_relevance", primitive: { kind: "choice", options: ["relevant", "partially_relevant", "not_relevant"] },
      question_text: "Is it relevant?", candidate_ids: ["cand-1"], required: true,
    }],
    limits: { deadline_ms: 30_000, max_candidates: 8, max_questions: 3, max_input_bytes: PROJECTION_LIMITS.max_input_bytes + WIRE_ENVELOPE_HEADROOM_BYTES, max_output_bytes: 64_000 },
    ...overrides,
  };
}

describe("sdk-http bridge wire construction", () => {
  test("CJK principal ids ride as deterministic ASCII stand-ins and still parse (J2)", () => {
    const request = wireRequest({ scope: { owner: "radar", project: "reading-judgment", principal: "profile-复仇者" } });
    const built = buildSdkWire(request, CAPS_MODEL);
    const tree = JSON.parse(built.wire);
    expect(tree.scope.principal_id).toMatch(/^rscope-[a-f0-9]{24}$/);
    expect(tree.scope.principal_id).not.toContain("复仇");
    // The SDK accepts the mapped wire outright (ID_PATTERN would have
    // rejected the original principal_id with scope_invalid).
    expect(() => parseRequest(built.wire)).not.toThrow();
  });

  test("non-ASCII candidate ids round-trip through the reverse map (J2)", () => {
    const request = wireRequest({ candidates: [{ candidate_id: "cand-复仇", source_ids: ["douyin:synthetic-0"] }], questions: [{
      question_id: "morning_relevance", primitive: { kind: "choice", options: ["relevant", "partially_relevant", "not_relevant"] },
      question_text: "Is it relevant?", candidate_ids: ["cand-复仇"], required: true,
    }] });
    const built = buildSdkWire(request, CAPS_MODEL);
    const sdkId = JSON.parse(built.wire).candidates[0].candidate_id;
    expect(sdkId).toMatch(/^rcand-[a-f0-9]{24}$/);
    expect(built.reverseCandidates.get(sdkId)).toBe("cand-复仇");
  });

  test("a full inline-budget projection fits the declared wire cap (J1)", () => {
    // 20_000 bytes of ASCII inline text — exactly the projection seal budget.
    // Before the headroom, the envelope (~4-5k units) pushed the canonical
    // wire past the old 20_000-unit cap and the SDK rejected it with
    // limits_exceeded:request_bytes_over_max_input_bytes.
    const sources = Array.from({ length: 10 }, (_, n) => ({
      source_id: `douyin:synthetic-${n}`, revision: 3, digest: DIGEST, inline_text: "x".repeat(2_000), language: "zh-Hans",
    }));
    const request = wireRequest({ sources });
    const built = buildSdkWire(request, CAPS_MODEL);
    expect(built.canonicalSize).toBeLessThanOrEqual(request.limits.max_input_bytes);
    expect(() => parseRequest(built.wire)).not.toThrow();
  });
});

describe("consumer evidence fixes", () => {
  function seededDb() {
    const dir = mkdtempSync(join(tmpdir(), "radar-jfix-"));
    const db = openDb(join(dir, "t.db"));
    for (let n = 0; n < 2; n++) db.insert(opportunities).values({
      ref: `opp-jfix-${n}`, date: "2026-09-21", clusterKey: `revenge|identity_reversal|${n}`, topic: "revenge", hookFamily: "identity_reversal", format: "default",
      marketScore: 80, evidenceConfidence: 80, degraded: 0, crossPlatform: 0, evidenceDigest: DIGEST, sourceRefsJson: JSON.stringify([`douyin:synthetic-${n}`]),
      builderVersion: "opportunity-builder.v1", createdAt: "2026-09-21T00:00:00.000Z",
    }).run();
    const profile = new ProfileService(db).create("jfix", { topics: [{ tag: "revenge", weight: 90 }], minimum_confidence: 30, minimum_fit: 30 });
    buildEdition(db, profile, "2026-09-21");
    return db;
  }

  test("an unknown outcome still reports its (possibly billed) evaluate call (J3)", async () => {
    const db = seededDb();
    const transport = createFixtureTransport({ scenario: "unknown-outcome" });
    const outcome = await evaluateReadingJudgment(db, { mode: "assist", transport, target: { kind: "edition" } });
    expect(outcome.outcome).toBe("failed");
    expect(outcome.record?.execution_status).toBe("unknown");
    expect(transport.calls.evaluate).toBe(1);
    expect(outcome.transport_evaluate_calls).toBe(1);
    db.$client.close();
  });

  test("discovery failures are pre-submission: not unknown, no reconcile_first (J4)", async () => {
    const db = seededDb();
    const flaky: JudgmentTransport = {
      transport: "flaky-discovery", ops: ["DescribeCapabilities", "Evaluate"],
      async describeCapabilities() { throw new Error("fetch failed: socket hang up"); },
      async evaluate() { throw new Error("evaluate must never run after failed discovery"); },
    };
    const outcome = await evaluateReadingJudgment(db, { mode: "shadow", transport: flaky, target: { kind: "edition" } });
    expect(outcome.outcome).toBe("failed");
    expect(outcome.record?.execution_status).toBe("failed");
    expect(outcome.record?.error?.submission_state).toBe("not_submitted");
    expect(outcome.record?.error?.retry_class).toBe("safe_before_submit");
    expect(outcome.transport_evaluate_calls).toBe(0);
    db.$client.close();
  });

  test("concurrent same-target evaluations serialize: the duplicate replays instead of overwriting (J5)", async () => {
    const db = seededDb();
    const [a, b] = await Promise.all([
      evaluateReadingJudgment(db, { mode: "assist", transport: createFixtureTransport(), target: { kind: "edition" } }),
      evaluateReadingJudgment(db, { mode: "assist", transport: createFixtureTransport(), target: { kind: "edition" } }),
    ]);
    // The duplicate no longer mints the same key and overwrites the first
    // evidence row: it waits and replays the stored attempt with zero calls.
    expect(a.outcome).toBe("evaluated");
    expect(b.outcome).toBe("replayed");
    expect(b.reused).toBe(true);
    expect(countReadingJudgments(db)).toBe(1);
    db.$client.close();
  });

  test("concurrent fresh evaluations keep distinct attempt keys and rows (J5)", async () => {
    const db = seededDb();
    const [a, b] = await Promise.all([
      evaluateReadingJudgment(db, { mode: "assist", transport: createFixtureTransport(), target: { kind: "edition" }, fresh: true }),
      evaluateReadingJudgment(db, { mode: "assist", transport: createFixtureTransport(), target: { kind: "edition" }, fresh: true }),
    ]);
    const rows = db.select().from(readingJudgments).all();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.attemptKey)).size).toBe(2);
    expect(a.record?.attempt_key).not.toBe(b.record?.attempt_key);
    expect(a.outcome).toBe("evaluated");
    expect(b.outcome).toBe("evaluated");
    db.$client.close();
  });

  test("repeated all-excluded evaluations replay one precheck row (J7)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "radar-jfix-empty-"));
    const db = openDb(join(dir, "t.db"));
    const target = { kind: "reading", language: "zh-Hans" } as const;
    const first = await evaluateReadingJudgment(db, { mode: "shadow", transport: createFixtureTransport(), target });
    expect(first.outcome).toBe("precheck_rejected");
    const second = await evaluateReadingJudgment(db, { mode: "shadow", transport: createFixtureTransport(), target });
    expect(second.outcome).toBe("replayed");
    expect(second.reused).toBe(true);
    expect(countReadingJudgments(db)).toBe(1);
    db.$client.close();
  });

  test("judgment status reports the true stored-attempt count, not the list cap (J6)", () => {
    const db = seededDb();
    for (let n = 0; n < 6; n++) db.insert(readingJudgments).values({
      attemptKey: `rj-status-a${n}`, requestId: "rj-status", attemptId: `rj-status-a${n}`, target: "edition",
      createdAt: "2026-09-22T00:00:00.000Z", payload: { attempt_key: `rj-status-a${n}` } as never,
    }).run();
    const status = judgmentStatusCommand(db, { enabled: false, mode: "off" });
    expect(status.facts?.stored_attempts).toBe(6);
    expect(status.summary).toContain("6 stored attempt(s)");
    db.$client.close();
  });
});
