import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type RadarDb } from "../../src/db/client.ts";
import { morningEditionEntries } from "../../src/db/schema.ts";
import { collect, defaultAdapters } from "../../src/pipeline/collect.ts";
import { scoreDay } from "../../src/pipeline/scoring.ts";
import { persistOpportunities, buildOpportunities } from "../../src/pipeline/opportunity.ts";
import { buildEdition, editionByRef, latestEdition } from "../../src/pipeline/edition.ts";
import { ProfileService } from "../../src/profile/service.ts";
import { addFeedback, feedbackAdjustment, KIND_SIGNAL } from "../../src/pipeline/feedback.ts";
import { rankOpportunities, RANKER_VERSION } from "../../src/pipeline/ranker.ts";

// The async factory above is awaited through this helper to keep types honest.
async function seed(): Promise<RadarDb> {
  const dir = mkdtempSync(join(tmpdir(), "radar-m2-"));
  const db = openDb(join(dir, "t.db"));
  const fixtureDir = new URL("../fixtures", import.meta.url).pathname;
  const now = new Date("2026-08-29T08:59:00Z");
  await collect(db, defaultAdapters(), { firecrawlBaseUrl: "unused", agentReachBin: "unused", timeoutMs: 5_000, fixtureDir }, now);
  await scoreDay(db, "2026-08-29");
  persistOpportunities(db, "2026-08-29", now);
  return db;
}

describe("opportunity-builder.v1 (2.4)", () => {
  test("clusters are deterministic, ref-stable and never fabricate metrics", async () => {
    const db = await seed();
    const a = buildOpportunities(db, "2026-08-29", new Date("2026-08-29T09:00:00Z"));
    const b = buildOpportunities(db, "2026-08-29", new Date("2026-08-30T09:00:00Z"));
    expect(a.map((o) => o.ref)).toEqual(b.map((o) => o.ref)); // same input, same output
    expect(a.length).toBeGreaterThan(5);
    for (const opp of a) {
      expect(opp.marketScore).toBeGreaterThanOrEqual(0);
      expect(opp.evidenceConfidence).toBeLessThanOrEqual(100);
      expect(opp.sourceRefs.length).toBeGreaterThan(0);
      expect(opp.evidenceDigest).toMatch(/^sha256:/);
    }
    // Cross-platform clusters carry the flag honestly.
    const cross = a.find((o) => o.crossPlatform);
    expect(cross).toBeDefined();
    expect(new Set(cross!.items.map((i) => i.platform)).size).toBe(2);
  });

  test("degraded members lower evidence confidence, never silently pass", async () => {
    const db = await seed();
    const opps = buildOpportunities(db, "2026-08-29");
    for (const opp of opps) {
      const maxMemberConf = opp.items.length > 0 ? 100 : 0;
      expect(opp.evidenceConfidence).toBeLessThanOrEqual(maxMemberConf);
    }
  });
});

describe("feedback ledger (2.2)", () => {
  test("fixed enum, idempotency and per-feature caps", async () => {
    const db = await seed();
    const svc = new ProfileService(db);
    const profile = svc.create("fb");
    const opp = buildOpportunities(db, "2026-08-29")[0]!;
    // Idempotent replay returns the original receipt.
    const r1 = addFeedback(db, { profileRef: profile.ref, opportunityRef: opp.ref, kind: "used" });
    const r2 = addFeedback(db, { profileRef: profile.ref, opportunityRef: opp.ref, kind: "used" });
    expect(r2.duplicate).toBe(true);
    expect(r2.createdAt).toBe(r1.createdAt);
    // Spamming "used" clamps at +15, not +4*n.
    for (let i = 0; i < 20; i++) {
      addFeedback(db, { profileRef: profile.ref, opportunityRef: opp.ref, kind: "used", idempotencyKey: `k-${i}` });
    }
    const adjustment = feedbackAdjustment(db, profile.ref, [`topic:${opp.topic}`]);
    expect(adjustment).toBe(15);
    // Unknown kind fails closed.
    expect(() => addFeedback(db, { profileRef: profile.ref, opportunityRef: opp.ref, kind: "love" })).toThrow(/kind must be/);
  });

  test("already_seen only suppresses the same evidence digest", async () => {
    const db = await seed();
    const svc = new ProfileService(db);
    const profile = svc.create("seen");
    const opps = buildOpportunities(db, "2026-08-29");
    const target = opps[0]!;
    addFeedback(db, { profileRef: profile.ref, opportunityRef: target.ref, kind: "already_seen" });
    const ranked = rankOpportunities(db, profile.profile, profile.ref, opps);
    expect(ranked.find((r) => r.opportunity.ref === target.ref)).toBeUndefined();
    expect(ranked.length).toBe(opps.length - 1);
    // The zero-signal kind must not shift preference at all.
    expect(feedbackAdjustment(db, profile.ref, [`topic:${target.topic}`])).toBe(0);
  });

  test("kind signals match the frozen table", () => {
    expect(KIND_SIGNAL).toEqual({ saved: 2, used: 4, dismissed: -2, not_relevant: -4, too_risky: -6, already_seen: 0 });
  });
});

describe("personal ranker (2.5)", () => {
  test("five-profile canary preflight stays isolated and explainable", async () => {
    const db = await seed();
    const svc = new ProfileService(db);
    const profiles = [
      svc.create("preflight-revenge", { topics: [{ tag: "revenge", weight: 100 }], hooks: [{ tag: "identity_reversal", weight: 90 }], minimum_fit: 0 }),
      svc.create("preflight-urban", { topics: [{ tag: "urban_power", weight: 100 }], hooks: [{ tag: "identity_reversal", weight: 70 }], minimum_fit: 0 }),
      svc.create("preflight-romance", { topics: [{ tag: "sweet_romance", weight: 100 }], minimum_fit: 0 }),
      svc.create("preflight-blocked", { topics: [{ tag: "revenge", weight: 100 }], blocked_topics: ["revenge"], minimum_fit: 0 }),
      svc.create("preflight-market", { budget_band: "premium", minimum_fit: 0 }),
    ];
    const opps = buildOpportunities(db, "2026-08-29");
    const before = profiles.map((profile) => ({
      profile,
      edition: buildEdition(db, profile, "2026-08-29").edition,
      ranked: rankOpportunities(db, profile.profile, profile.ref, opps),
    }));

    expect(new Set(before.map(({ edition }) => edition.editionRef)).size).toBe(5);
    expect(new Set(before.map(({ ranked }) => JSON.stringify(ranked.map((row) => row.opportunity.ref)))).size).toBeGreaterThanOrEqual(4);
    expect(before[3]!.ranked.some((row) => row.opportunity.topic === "revenge")).toBe(false);
    expect(before.flatMap(({ ranked }) => ranked.flatMap((row) => row.reasonCodes)).length).toBeGreaterThan(0);

    const urbanOrder = before[1]!.ranked.map((row) => row.opportunity.ref);
    addFeedback(db, { profileRef: profiles[0]!.ref, opportunityRef: before[0]!.ranked[0]!.opportunity.ref, kind: "saved", idempotencyKey: "five-profile-preflight" });
    expect(rankOpportunities(db, profiles[1]!.profile, profiles[1]!.ref, opps).map((row) => row.opportunity.ref)).toEqual(urbanOrder);
    expect(rankOpportunities(db, profiles[0]!.profile, profiles[0]!.ref, opps).some((row) => row.reasonCodes.includes("feedback_positive"))).toBe(true);
    for (const { edition } of before) expect(editionByRef(db, edition.editionRef)!.digest).toBe(edition.digest);
  });

  test("different profiles produce explainable different orders over the same evidence", async () => {
    const db = await seed();
    const svc = new ProfileService(db);
    const romance = svc.create("romance", { topics: [{ tag: "sweet_romance", weight: 90 }], hooks: [] });
    const revenge = svc.create("revenge", { topics: [{ tag: "revenge", weight: 90 }] });
    const opps = buildOpportunities(db, "2026-08-29");
    const orderRomance = rankOpportunities(db, romance.profile, romance.ref, opps).map((r) => r.opportunity.topic);
    const orderRevenge = rankOpportunities(db, revenge.profile, revenge.ref, opps).map((r) => r.opportunity.topic);
    expect(orderRomance[0]).toBe("sweet_romance");
    expect(orderRevenge[0]).toBe("revenge");
    expect(orderRomance).not.toEqual(orderRevenge);
  });

  test("blocked topics hard-filter and feedback cannot resurrect them", async () => {
    const db = await seed();
    const svc = new ProfileService(db);
    const profile = svc.create("blocked", { topics: [{ tag: "revenge", weight: 100 }], blocked_topics: ["revenge"] });
    const opps = buildOpportunities(db, "2026-08-29");
    const ranked = rankOpportunities(db, profile.profile, profile.ref, opps);
    expect(ranked.some((r) => r.opportunity.topic === "revenge")).toBe(false);
    const revengeOpp = opps.find((o) => o.topic === "revenge")!;
    for (let i = 0; i < 10; i++) {
      addFeedback(db, { profileRef: profile.ref, opportunityRef: revengeOpp.ref, kind: "used", idempotencyKey: `b-${i}` });
    }
    const after = rankOpportunities(db, profile.profile, profile.ref, opps);
    expect(after.some((r) => r.opportunity.topic === "revenge")).toBe(false); // blocked wins
  });

  test("tie-break is stable: rankScore, evidence confidence, market score, ref", async () => {
    const db = await seed();
    const svc = new ProfileService(db);
    const profile = svc.create("ties");
    const opps = buildOpportunities(db, "2026-08-29");
    const r1 = rankOpportunities(db, profile.profile, profile.ref, opps).map((r) => r.opportunity.ref);
    const r2 = rankOpportunities(db, profile.profile, profile.ref, [...opps].reverse()).map((r) => r.opportunity.ref);
    expect(r1).toEqual(r2); // input order must not change output order
  });

  test("reason codes come only from the stable enum", async () => {
    const db = await seed();
    const svc = new ProfileService(db);
    const profile = svc.create("reasons", { topics: [{ tag: "revenge", weight: 100 }], hooks: [{ tag: "identity_reversal", weight: 80 }] });
    const opps = buildOpportunities(db, "2026-08-29");
    for (const r of rankOpportunities(db, profile.profile, profile.ref, opps)) {
      for (const code of r.reasonCodes) {
        expect(["topic_match", "hook_match", "asset_reuse", "budget_fit", "cross_platform_signal", "feedback_positive", "feedback_negative", "risk_near_limit", "low_confidence"]).toContain(code);
      }
    }
    expect(RANKER_VERSION).toBe("personal-ranker.v1");
  });
});

describe("morning edition (2.6)", () => {
  test("edition is immutable: feedback/profile updates never rewrite history", async () => {
    const db = await seed();
    const svc = new ProfileService(db);
    const profile = svc.create("hist", { topics: [{ tag: "sweet_romance", weight: 100 }], hooks: [{ tag: "identity_reversal", weight: 100 }], minimum_confidence: 30, minimum_fit: 40 });
    const first = buildEdition(db, profile, "2026-08-29").edition;
    expect(first.entries.length).toBeGreaterThan(0);
    // Feedback after the fact...
    addFeedback(db, { profileRef: profile.ref, opportunityRef: first.entries[0]!.opportunityRef, kind: "not_relevant" });
    // ...and a profile revision...
    const updated = svc.set(profile.ref, { topics: [{ tag: "revenge", weight: 100 }] });
    // ...must leave the stored edition untouched.
    const stored = editionByRef(db, first.editionRef)!;
    expect(stored.entries.map((e) => e.opportunityRef)).toEqual(first.entries.map((e) => e.opportunityRef));
	expect(stored.entries.map((e) => e.topic)).toEqual(first.entries.map((e) => e.topic));
	expect(stored.entries.map((e) => e.sourceRefs)).toEqual(first.entries.map((e) => e.sourceRefs));
	expect(stored.entries.map((e) => e.degraded)).toEqual(first.entries.map((e) => e.degraded));
    expect(stored.profileRevision).toBe(first.profileRevision);
    expect(stored.digest).toBe(first.digest);
    // A new build creates a NEW ref bound to the new revision.
    const second = buildEdition(db, updated, "2026-08-29").edition;
    expect(second.editionRef).not.toBe(first.editionRef);
    expect(second.profileRevision).toBe(updated.headRevision);
  });

	test("migration adds immutable entry metadata columns to an existing database", () => {
	  const dir = mkdtempSync(join(tmpdir(), "radar-edition-migrate-"));
	  const path = join(dir, "legacy.db");
	  const legacy = new Database(path);
	  legacy.exec(`
		CREATE TABLE morning_edition_entries (
		  id INTEGER PRIMARY KEY AUTOINCREMENT,
		  edition_ref TEXT NOT NULL,
		  position INTEGER NOT NULL,
		  opportunity_ref TEXT NOT NULL,
		  market_score INTEGER NOT NULL,
		  personal_fit INTEGER NOT NULL,
		  evidence_confidence INTEGER NOT NULL,
		  reason_codes_json TEXT NOT NULL DEFAULT '[]'
		);
	  `);
	  legacy.close();
	  const db = openDb(path);
	  expect(db.select().from(morningEditionEntries).all()).toEqual([]);
	});

  test("honest empty: threshold-only misses are explained, not padded", async () => {
    const db = await seed();
    const svc = new ProfileService(db);
    const profile = svc.create("empty", { minimum_fit: 99, minimum_confidence: 99 });
    const { edition } = buildEdition(db, profile, "2026-08-29");
    expect(edition.status).toBe("empty");
    expect(edition.entries).toEqual([]);
    expect(edition.limitations.join(" ")).toMatch(/below admission thresholds/);
  });

  test("missing data day yields empty with a real reason", async () => {
    const db = await seed();
    const svc = new ProfileService(db);
    const profile = svc.create("nodata");
    const { edition } = buildEdition(db, profile, "2025-01-01");
    expect(edition.status).toBe("empty");
    expect(edition.limitations.join(" ")).toContain("no scored opportunities");
  });

  test("blocked topics explanation appears in empty editions", async () => {
    const db = await seed();
    const svc = new ProfileService(db);
    const profile = svc.create("blocked-empty", { minimum_fit: 99, blocked_topics: ["revenge"] });
    const { edition } = buildEdition(db, profile, "2026-08-29");
    expect(edition.limitations.join(" ")).toMatch(/hard-filtered by blocked topics/);
  });

  test("limit 8 by default; no low-quality padding below thresholds", async () => {
    const db = await seed();
    const svc = new ProfileService(db);
    const profile = svc.create("limit", { topics: [{ tag: "revenge", weight: 100 }, { tag: "sweet_romance", weight: 100 }, { tag: "urban_power", weight: 100 }, { tag: "fantasy", weight: 100 }, { tag: "suspense", weight: 100 }, { tag: "family_conflict", weight: 100 }], hooks: [{ tag: "identity_reversal", weight: 100 }, { tag: "face_slap", weight: 100 }, { tag: "secret_reveal", weight: 100 }, { tag: "countdown", weight: 100 }], minimum_fit: 10, minimum_confidence: 20 });
    const { edition } = buildEdition(db, profile, "2026-08-29");
    expect(edition.entries.length).toBeLessThanOrEqual(8);
    for (const e of edition.entries) {
      expect(e.personalFit).toBeGreaterThanOrEqual(10);
      expect(e.evidenceConfidence).toBeGreaterThanOrEqual(20);
    }
  });

  test("latest edition lookup is per-profile isolated", async () => {
    const db = await seed();
    const svc = new ProfileService(db);
    const a = svc.create("iso-a", { topics: [{ tag: "revenge", weight: 100 }], hooks: [{ tag: "identity_reversal", weight: 100 }], minimum_confidence: 30, minimum_fit: 30 });
    const b = svc.create("iso-b", { topics: [{ tag: "sweet_romance", weight: 100 }], hooks: [{ tag: "identity_reversal", weight: 100 }], minimum_confidence: 30, minimum_fit: 30 });
    buildEdition(db, a, "2026-08-29");
    buildEdition(db, b, "2026-08-29");
    expect(latestEdition(db, a.ref)!.profileRef).toBe(a.ref);
    expect(latestEdition(db, b.ref)!.profileRef).toBe(b.ref);
    expect(latestEdition(db, a.ref)!.editionRef).not.toBe(latestEdition(db, b.ref)!.editionRef);
  });
});

describe("card.v1 unchanged alongside editions (2.8)", () => {
  test("card still emits the frozen contract after the personal layer lands", async () => {
    const db = await seed();
    const svc = new ProfileService(db);
    svc.create("card-check");
    const { buildCard } = await import("../../src/pipeline/card.ts");
    const card = buildCard(db, "2026-08-29", new Date("2026-08-29T08:59:00Z"));
    expect(card.contract).toBe("short-drama-radar.card.v1");
    expect(card.top.douyin).toHaveLength(3);
    expect(card.top.xiaohongshu).toHaveLength(3);
    expect([...card.top.douyin, ...card.top.xiaohongshu].every((item) => item.confidence >= 60)).toBe(true);
  });
});
