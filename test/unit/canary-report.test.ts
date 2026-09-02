import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db/client.ts";
import { morningEditionEntries, morningEditions, personalProfileRevisions, preferenceFeedback } from "../../src/db/schema.ts";
import { buildCanaryReport } from "../../src/pipeline/canary.ts";
import { defaultProfile, profileDigest } from "../../src/profile/domain.ts";

describe("14-day personal canary report", () => {
  test("derives quantitative gates from immutable editions and feedback", () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), "radar-canary-")), "t.db"));
    const profile = defaultProfile("canary");
    for (let revision = 1; revision <= 3; revision++) {
      db.insert(personalProfileRevisions).values({
        profileRef: "profile-canary",
        revision,
        profileJson: JSON.stringify(profile),
        digest: profileDigest(profile),
        createdAt: `2026-08-${String(20 + revision).padStart(2, "0")}T08:00:00Z`,
      }).run();
    }

    for (let i = 0; i < 10; i++) {
      const day = `2026-08-${String(22 + i).padStart(2, "0")}`;
      const ref = `edition-${i}`;
      const entries = i < 8 ? 1 : 0;
      db.insert(morningEditions).values({
        editionRef: ref,
        profileRef: "profile-canary",
        profileRevision: Math.min(3, i + 1),
        date: day,
        generatedAt: `${day}T08:59:00Z`,
        builderVersion: "opportunity-builder.v1",
        rankerVersion: "personal-ranker.v1",
        sourceRunRefsJson: "[]",
        evidenceDigest: `sha256:evidence${i}`,
        status: i === 7 ? "degraded" : entries === 0 ? "empty" : "ready",
        limitationsJson: "[]",
        digest: `sha256:edition${i}`,
      }).run();
      if (entries === 0) continue;
      db.insert(morningEditionEntries).values({
        editionRef: ref,
        position: 1,
        opportunityRef: `opp-${i}`,
        marketScore: 70,
        personalFit: 75,
        evidenceConfidence: 80,
        reasonCodesJson: i === 1 ? "[]" : JSON.stringify(["topic_match"]),
      }).run();
      if (i < 5) {
        db.insert(preferenceFeedback).values({
          profileRef: "profile-canary",
          opportunityRef: `opp-${i}`,
          kind: i === 0 ? "used" : "saved",
          matchedFeaturesJson: "[]",
          projectRef: "",
          idempotencyKey: `useful-${i}`,
          createdAt: `${day}T10:00:00Z`,
        }).run();
      }
      if (i === 0) {
        db.insert(preferenceFeedback).values({
          profileRef: "profile-canary",
          opportunityRef: "opp-0",
          kind: "not_relevant",
          matchedFeaturesJson: "[]",
          projectRef: "",
          idempotencyKey: "false-positive-0",
          createdAt: `${day}T11:00:00Z`,
        }).run();
      }
    }

    const report = buildCanaryReport(db, "profile-canary", 14, new Date("2026-08-31T12:00:00Z"));
    expect(report.spec).toBe("radar.canary_report.v1");
    expect(report.editionDays).toBe(10);
    expect(report.nonEmptyEditionDays).toBe(8);
    expect(report.usefulNonEmptyDays).toBe(5);
    expect(report.usefulnessRate).toBe(0.63);
    expect(report.falsePositiveEntries).toBe(1);
    expect(report.unexplainedEntries).toBe(1);
    expect(report.falseOrUnexplainedRate).toBe(0.25);
    expect(report.emptyDays).toBe(2);
    expect(report.degradedDays).toBe(1);
    expect(report.profileAdjustments).toBe(2);
    expect(report.quantitativePassed).toBe(true);
    expect(report.gates.secret_leak_review?.status).toBe("manual_required");
    expect(JSON.stringify(report)).not.toMatch(/profileJson|projectRef|idempotencyKey/);
  });
});
