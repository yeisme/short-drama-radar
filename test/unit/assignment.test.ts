import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db/client.ts";
import { preferenceFeedback } from "../../src/db/schema.ts";
import { ProfileService } from "../../src/profile/service.ts";
import { collect, defaultAdapters } from "../../src/pipeline/collect.ts";
import { scoreDay } from "../../src/pipeline/scoring.ts";
import { persistOpportunities } from "../../src/pipeline/opportunity.ts";
import { buildEdition } from "../../src/pipeline/edition.ts";
import { assignmentByRef, createAssignment, produceAssignment, rejectAssignment, submitAssignment } from "../../src/pipeline/assignment.ts";
import { initializeMarket } from "../../src/market/sources.ts";

async function seeded() {
  const dir = mkdtempSync(join(tmpdir(), "radar-assign-"));
  const db = openDb(join(dir, "t.db"));
  const fixtureDir = new URL("../fixtures", import.meta.url).pathname;
  const now = new Date("2026-08-29T08:59:00Z");
  await collect(db, defaultAdapters(), { firecrawlBaseUrl: "unused", agentReachBin: "unused", timeoutMs: 5_000, fixtureDir }, now);
  await scoreDay(db, "2026-08-29");
  persistOpportunities(db, "2026-08-29", now);
  return db;
}

test("empty edition creates a do_not_shoot assignment without used feedback", async () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    const profiles = new ProfileService(db);
    const profile = profiles.create("empty-assign", { minimum_fit: 100, minimum_confidence: 100 });
    const { edition } = buildEdition(db, profile, "2026-09-15");
    expect(edition.status).toBe("empty");
    const first = createAssignment(db, { profile, editionRef: edition.editionRef });
    expect(first.assignment.status).toBe("do_not_shoot");
    expect(first.assignment.opportunity_ref).toBeNull();
    expect(first.assignment.downstream_status).toBe("not_submitted");
    expect(first.assignment.target_owner).toBe("auctra");
    expect(first.assignment.why_this).toEqual(["edition_empty"]);
    const replay = createAssignment(db, { profile, editionRef: edition.editionRef });
    expect(replay.reused).toBe(true);
    expect(replay.assignment.assignment_ref).toBe(first.assignment.assignment_ref);
    expect(db.select().from(preferenceFeedback).all()).toHaveLength(0);
  } finally { db.$client.close(); }
});

test("ready edition assignment is idempotent, stale-safe and reject writes feedback", async () => {
  const db = await seeded();
  try {
    const profiles = new ProfileService(db);
    const profile = profiles.create("assign", { minimum_fit: 0, minimum_confidence: 0 });
    const { edition } = buildEdition(db, profile, "2026-08-29");
    expect(edition.entries.length).toBeGreaterThan(0);
    const created = createAssignment(db, { profile, editionRef: edition.editionRef });
    expect(created.assignment.status).toBe("ready");
    expect(created.assignment.opportunity_ref).toBe(edition.entries[0]!.opportunityRef);
    expect(created.assignment.scores.personal_fit).toBe(edition.entries[0]!.personalFit);
    expect(created.assignment.why_not_others.length).toBe(edition.entries.length - 1);
    const shown = assignmentByRef(db, "latest", profile.ref);
    expect(shown.assignment_ref).toBe(created.assignment.assignment_ref);
    const updated = profiles.set(profile.ref, { risk_tolerance: 10 });
    expect(() => createAssignment(db, { profile: updated, editionRef: edition.editionRef }))
      .toThrow(/Profile changed/);
    const current = profiles.show(profile.ref);
    // Rebuild so the new revision can assign, then reject the original? The
    // original assignment still belongs to revision 1. Reject against head
    // must stale.
    expect(() => rejectAssignment(db, { profile: current, assignmentRef: created.assignment.assignment_ref, kind: "too_risky" }))
      .toThrow(/Profile changed/);
  } finally { db.$client.close(); }
});

test("reject on matching profile revision writes too_risky and does not record used", async () => {
  const db = await seeded();
  try {
    const profiles = new ProfileService(db);
    const profile = profiles.create("reject-assign", { minimum_fit: 0, minimum_confidence: 0 });
    const { edition } = buildEdition(db, profile, "2026-08-29");
    const created = createAssignment(db, { profile, opportunityRef: edition.entries[0]!.opportunityRef });
    const rejected = rejectAssignment(db, { profile, assignmentRef: created.assignment.assignment_ref, kind: "too_risky" });
    expect(rejected.assignment.status).toBe("rejected");
    const kinds = db.select().from(preferenceFeedback).all().map(row => row.kind);
    expect(kinds).toEqual(["too_risky"]);
    expect(kinds).not.toContain("used");
  } finally { db.$client.close(); }
});

test("submit records used only after a pending_review receipt", async () => {
  const db = await seeded();
  try {
    const profiles = new ProfileService(db);
    const profile = profiles.create("submit-assign", { minimum_fit: 0, minimum_confidence: 0 });
    buildEdition(db, profile, "2026-08-29");
    const created = createAssignment(db, { profile });
    expect(() => submitAssignment(db, {
      profile, assignmentRef: created.assignment.assignment_ref, auctraPath: "/tmp/auctra-project",
      runAuctra: () => ({ exitCode: 1, stdout: "", stderr: "auctra missing" }),
    })).toThrow(/auctra missing/);
    expect(db.select().from(preferenceFeedback).all()).toHaveLength(0);
    const submitted = submitAssignment(db, {
      profile, assignmentRef: created.assignment.assignment_ref, auctraPath: "/tmp/auctra-project",
      runAuctra: () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          status: "success",
          facts: { unit_ref: "scene_001" },
          data: { proposal_ref: "proposal:abc", review_ref: "review:abc", status: "pending_review" },
        }),
        stderr: "",
      }),
    });
    expect(submitted.assignment.downstream_status).toBe("submitted");
    expect(submitted.assignment.auctra?.proposal_ref).toBe("proposal:abc");
    const replay = submitAssignment(db, {
      profile, assignmentRef: created.assignment.assignment_ref, auctraPath: "/tmp/auctra-project",
      runAuctra: () => { throw new Error("should not rerun auctra"); },
    });
    expect(replay.reused).toBe(true);
    expect(db.select().from(preferenceFeedback).all().map(row => row.kind)).toEqual(["used"]);
    expect(() => rejectAssignment(db, { profile, assignmentRef: created.assignment.assignment_ref, kind: "too_risky" }))
      .toThrow(/Submitted assignments/);
    expect(() => produceAssignment(db, {
      profile, assignmentRef: created.assignment.assignment_ref, scaenaPath: "/tmp/scaena-project",
      runAuctra: () => ({
        exitCode: 0,
        stdout: JSON.stringify({ status: "success", data: { status: "pending_review", proposal_ref: "proposal:abc" } }),
        stderr: "",
      }),
    })).toThrow(/not accepted/);
    const produced = produceAssignment(db, {
      profile, assignmentRef: created.assignment.assignment_ref, scaenaPath: "/tmp/scaena-project",
      runAuctra: () => ({
        exitCode: 0,
        stdout: JSON.stringify({ status: "success", data: { status: "accepted", proposal_ref: "proposal:abc", review_ref: "review:abc", target_unit_ref: "scene_001", canonical_revision: "version_scene_001_002" } }),
        stderr: "",
      }),
      runScaena: () => ({
        exitCode: 0,
        stdout: JSON.stringify({ status: "success", facts: { receipt_ref: "radar-receipt-demo" }, data: { receipt: { receipt_ref: "radar-receipt-demo" } } }),
        stderr: "",
      }),
    });
    expect(produced.assignment.downstream_status).toBe("produced");
    expect(produced.assignment.scaena?.receipt_ref).toBe("radar-receipt-demo");
  } finally { db.$client.close(); }
});

test("do_not_shoot assignments cannot be submitted", async () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    const profiles = new ProfileService(db);
    const profile = profiles.create("empty-submit", { minimum_fit: 100, minimum_confidence: 100 });
    const { edition } = buildEdition(db, profile, "2026-09-15");
    const created = createAssignment(db, { profile, editionRef: edition.editionRef });
    expect(() => submitAssignment(db, {
      profile, assignmentRef: created.assignment.assignment_ref, auctraPath: "/tmp/auctra-project",
      runAuctra: () => ({ exitCode: 0, stdout: "{}", stderr: "" }),
    })).toThrow(/ready assignment/);
  } finally { db.$client.close(); }
});
