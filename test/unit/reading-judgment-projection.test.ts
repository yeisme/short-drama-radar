import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { openDb, type RadarDb } from "../../src/db/client.ts";
import { opportunities } from "../../src/db/schema.ts";
import { buildEdition, latestEdition } from "../../src/pipeline/edition.ts";
import { ProfileService } from "../../src/profile/service.ts";
import { projectEditionForJudgment, projectReadingForJudgment, toReadingProjectionItems, EXCLUSION_REASONS, PROJECTION_LIMITS } from "../../src/judgment/projection.ts";
import { QUESTION_SET_VERSION, JUDGMENT_POLICY_VERSION, READING_JUDGMENT_POLICY, questionSetRef, policyRef } from "../../src/judgment/questionset.ts";
import { initializeMarket, registerSourceCandidate, updateSettings } from "../../src/market/sources.ts";
import { importCatalog } from "../../src/market/catalog.ts";
import { listChineseReading } from "../../src/market/translation.ts";
import { listWorkMappings } from "../../src/market/identity.ts";

// radar-reading-judgment-v1 task 1.1 — the minimal domain projection and the
// versioned question set cover every design scenario (morning-relevance,
// cross-market, false-negative-retention) and never leak unauthorized text.

const databases: ReturnType<typeof openDb>[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.$client.close()));

function editionDb(): { db: RadarDb; profile: ReturnType<ProfileService["show"]> } {
  const db = openDb(":memory:");
  databases.push(db);
  const date = "2026-09-21";
  const rows = [
    { topic: "revenge", hook: "identity_reversal", ref: "opp-revenge" },
    { topic: "sweet_romance", hook: "secret_reveal", ref: "opp-romance" },
    { topic: "urban_power", hook: "face_slap", ref: "opp-urban" },
  ];
  for (const [i, row] of rows.entries()) {
    db.insert(opportunities).values({
      ref: row.ref, date, clusterKey: `${row.topic}|${row.hook}|default`, topic: row.topic, hookFamily: row.hook,
      format: "default", marketScore: 70 + i, evidenceConfidence: 80, degraded: 0, crossPlatform: 0,
      evidenceDigest: `sha256:${row.ref}`, sourceRefsJson: JSON.stringify([`douyin:${row.ref}`]),
      builderVersion: "opportunity-builder.v1", createdAt: "2026-09-21T00:00:00.000Z",
    }).run();
  }
  const svc = new ProfileService(db);
  const profile = svc.create("proj", { topics: [{ tag: "revenge", weight: 90 }], minimum_confidence: 30, minimum_fit: 30 });
  const { edition } = buildEdition(db, profile, date);
  expect(edition.entries.length).toBeGreaterThan(0);
  return { db, profile: svc.show(profile.ref) };
}

async function readingDb() {
  const db = openDb(":memory:");
  databases.push(db);
  initializeMarket(db);
  registerSourceCandidate(db, { source_ref: "reelshort-ja", publisher_group: "reelshort", locale: "ja", markets: ["JP"] });
  const html = readFileSync("test/fixtures/market/reelshort-ja-fields.html", "utf8");
  await importCatalog(db, { source: "reelshort-ja", content: html, format: "html", observedAt: "2026-09-17T00:00:00Z", origin: "fixture" });
  return db;
}

describe("question set and policy are versioned and bound", () => {
  test("frozen ids, digests and per-language thresholds with no global default", () => {
    expect(QUESTION_SET_VERSION).toBe("1");
    expect(JUDGMENT_POLICY_VERSION).toBe("1");
    const set = questionSetRef(), policy = policyRef();
    expect(set.id).toBe("radar.reading_judgment.question_set.v1");
    expect(policy.id).toBe("radar.reading_judgment.policy.v1");
    expect(set.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(policy.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Same definition -> same digest (stable version binding).
    expect(questionSetRef().digest).toBe(set.digest);
    // Thresholds are per language and not calibrated yet; there is no global
    // numeric confidence default such as 0.8.
    expect(READING_JUDGMENT_POLICY.per_language_thresholds.map((t) => t.language).sort()).toEqual(["en", "zh-Hans", "zh-Hant"]);
    expect(READING_JUDGMENT_POLICY.per_language_thresholds.every((t) => t.threshold === null)).toBe(true);
    expect(JSON.stringify(READING_JUDGMENT_POLICY)).not.toContain("0.8");
    expect(READING_JUDGMENT_POLICY.suggestions_are_advisory_only).toBe(true);
    expect(READING_JUDGMENT_POLICY.judgment_confidence_may_override_evidence_confidence).toBe(false);
  });
});

describe("morning-relevance: edition projection is bounded and deterministic", () => {
  test("projects watch concerns, manifest and per-candidate sources without touching the edition", () => {
    const { db, profile } = editionDb();
    const before = latestEdition(db, profile.ref)!;
    const projection = projectEditionForJudgment(db, profile);
    const after = latestEdition(db, profile.ref)!;
    expect(after.digest).toBe(before.digest); // canonical state untouched

    expect(projection.spec).toBe("radar.reading_judgment.projection.v1");
    expect(projection.target).toBe("edition");
    expect(projection.context.edition_ref).toBe(before.editionRef);
    expect(projection.context.edition_digest).toBe(before.digest);
    const ids = projection.sources.map((s) => s.source_id);
    expect(ids).toContain("watch-concerns");
    expect(ids).toContain("edition-manifest");
    // Every admitted candidate binds its own + peer + shared sources and the
    // owner-side opportunity ref; pairs never rely on array order.
    for (const candidate of projection.candidates) {
      expect(candidate.binding.kind).toBe("edition_entry");
      if (candidate.deterministic.admitted) {
        expect(candidate.source_ids).toContain(candidate.candidate_id);
        expect(candidate.source_ids).toContain(`peers-${candidate.candidate_id.slice(5)}`);
        expect(new Set(candidate.source_ids).size).toBe(candidate.source_ids.length);
      }
    }
    expect(projection.candidates.some((c) => (c.binding as { opportunity_ref: string }).opportunity_ref === "opp-revenge")).toBe(true);
    // Watch concerns carry tag labels only — no profile name or free text.
    const concerns = projection.sources.find((s) => s.source_id === "watch-concerns")!;
    expect(concerns.inline_text).toContain("revenge");
    expect(concerns.inline_text).not.toContain("proj"); // profile name never leaves
    // Deterministic flags are computed before any model call.
    expect(projection.candidates.every((c) => c.deterministic.market === "unknown" && c.deterministic.market_basis === "unknown")).toBe(true);
    // Identical inputs digest identically (replay identity).
    expect(projectEditionForJudgment(db, profile).input_digest).toBe(projection.input_digest);
  });

  test("projection is bounded by the input caps", () => {
    expect(PROJECTION_LIMITS.max_candidates).toBeLessThanOrEqual(8);
    expect(PROJECTION_LIMITS.max_questions).toBe(3);
    const { db, profile } = editionDb();
    for (const source of projectEditionForJudgment(db, profile).sources) {
      expect(source.inline_text.length).toBeLessThanOrEqual(PROJECTION_LIMITS.max_source_bytes);
    }
  });
});

describe("cross-market: language never becomes an audience market", () => {
  test("reading candidates keep language and market labels separate; missing evidence stays unknown", async () => {
    const db = await readingDb();
    const list = listChineseReading(db, { language: "zh-Hans" });
    expect(list.items.length).toBeGreaterThan(0);
    const projection = projectReadingForJudgment(db, "zh-Hans", toReadingProjectionItems(list), list.omitted);
    const candidate = projection.candidates[0]!;
    // Source locale is ja; the registered market scope JP is NOT inferred from
    // the locale or the language of the reading list — the catalog fixture
    // carries no market evidence, so the binding must stay unknown.
    expect(candidate.deterministic.language).toBe("ja");
    expect(candidate.deterministic.market).toBe("unknown");
    expect(candidate.deterministic.market_basis).toBe("unknown");
    expect(candidate.deterministic.verifiable_market_evidence).toBe(false);
    const inline = projection.sources.find((s) => s.source_id === candidate.candidate_id)!.inline_text;
    expect(inline).toContain("language_label: ja (content language only)");
    expect(inline).toContain("market_label: unknown (basis: unknown)");
    // The edition side keeps the same separation with the profile language.
    const { db: edb, profile } = editionDb();
    const editionProjection = projectEditionForJudgment(edb, profile);
    for (const c of editionProjection.candidates) {
      expect(c.deterministic.language).toBe("zh"); // profile language tag
      expect(c.deterministic.market).toBe("unknown");
    }
  });
});

describe("false-negative-retention: excluded candidates stay recorded, never silently dropped", () => {
  test("sensitive or unclassifiable items are excluded from model input but retained in the record", async () => {
    const db = await readingDb();
    updateSettings(db, 1, { blocked_topics: ["fantasy"] });
    const list = listChineseReading(db, { language: "zh-Hans" });
    const crafted = [
      ...toReadingProjectionItems(list),
      {
        work_ref: "reelshort-ja-work-inject", work_revision: 1, original_title: "token=sk-livecandidatevalue00",
        source_ref: "reelshort-ja", source_locale: "ja", status: "missing" as const, display_title: "token=sk-livecandidatevalue00",
        translation: null,
      },
      {
        work_ref: "reelshort-ja-work-unclassified", work_revision: 1, original_title: "未分類の物語",
        source_ref: "reelshort-ja", source_locale: "ja", status: "missing" as const, display_title: "未分類の物語",
        translation: null,
      },
    ];
    const projection = projectReadingForJudgment(db, "zh-Hans", crafted, list.omitted);
    const byWork = new Map(projection.candidates.map((c) => [(c.binding as { work_ref: string }).work_ref, c]));
    const inject = byWork.get("reelshort-ja-work-inject")!;
    expect(inject.deterministic.admitted).toBe(false);
    expect(inject.deterministic.exclusion_reasons).toContain("sensitive_material");
    const unclassified = byWork.get("reelshort-ja-work-unclassified")!;
    expect(unclassified.deterministic.admitted).toBe(false);
    expect(unclassified.deterministic.exclusion_reasons).toContain("unclassified_against_policy");
    // Retained in the record (explicit feedback can still reference them)…
    expect(byWork.size).toBe(crafted.length);
    // …but their text is absent from every source sent to a model.
    const allText = projection.sources.map((s) => s.inline_text).join("\n");
    expect(allText).not.toContain("sk-livecandidatevalue00");
    expect(allText).not.toContain("未分類の物語");
    for (const reason of projection.candidates.flatMap((c) => c.deterministic.exclusion_reasons)) {
      expect(EXCLUSION_REASONS).toContain(reason);
    }
  });
});

describe("no unauthorized text leaves the domain", () => {
  test("inline texts carry only allowlisted fields — no URLs, digests or identity payloads", async () => {
    const db = await readingDb();
    const list = listChineseReading(db, { language: "zh-Hans" });
    const mapping = listWorkMappings(db)[0]!;
    const projection = projectReadingForJudgment(db, "zh-Hans", toReadingProjectionItems(list), list.omitted);
    for (const source of projection.sources) {
      expect(source.inline_text).not.toMatch(/https?:\/\//); // public URLs stay owner-side refs
      expect(source.inline_text).not.toContain("sha256:"); // digests are never model input
      expect(source.inline_text.length).toBeLessThanOrEqual(PROJECTION_LIMITS.max_source_bytes);
    }
    // Work aliases and evidence refs never appear either.
    const allText = projection.sources.map((s) => s.inline_text).join("\n");
    for (const alias of mapping.aliases) expect(allText).not.toContain(alias);
    expect(projection.input_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The versioned authorization binding pins the market policy revision.
    expect(projection.authorization.market_policy_revision).toMatch(/^sha256:/);
  });
});
