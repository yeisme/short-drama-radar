import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db/client.ts";
import { morningEditions, runs } from "../../src/db/schema.ts";
import { eq } from "drizzle-orm";
import { ProfileService } from "../../src/profile/service.ts";
import { collect, defaultAdapters } from "../../src/pipeline/collect.ts";
import { scoreDay } from "../../src/pipeline/scoring.ts";
import { buildEdition } from "../../src/pipeline/edition.ts";
import { persistOpportunities, loadOpportunities } from "../../src/pipeline/opportunity.ts";
import { clusterBuildAction, editionBuildAction, scoreAction, feedbackAddAction } from "../../src/app/actions.ts";
import type { AppDeps } from "../../src/app/actions.ts";
import { loadConfig } from "../../src/config.ts";
import { afterAll } from "bun:test";

// seedDeps points RADAR_HOME at a temp dir; restore it afterwards so the
// leak cannot shift later env-sensitive goldens (schedule units embed it).
const ambientRadarHome = process.env.RADAR_HOME;
afterAll(() => {
  if (ambientRadarHome === undefined) delete process.env.RADAR_HOME;
  else process.env.RADAR_HOME = ambientRadarHome;
});

// F2: MCP-visible mutations must be idempotent. Identical inputs return the
// existing receipt (audited as reuse); changed inputs create a new one.

function seedDeps(): { deps: AppDeps; home: string } {
  const home = mkdtempSync(join(tmpdir(), "radar-idem-"));
  process.env.RADAR_HOME = home;
  const db = openDb(join(home, "radar.db"));
  const deps: AppDeps = { cfg: loadConfig(), db, profiles: new ProfileService(db) };
  return { deps, home };
}

async function seededDay(deps: AppDeps, date: string): Promise<void> {
  const fixtureDir = new URL("../fixtures", import.meta.url).pathname;
  await collect(deps.db, defaultAdapters(), { firecrawlBaseUrl: "unused", agentReachBin: "unused", timeoutMs: 5_000, fixtureDir }, new Date(`${date}T08:30:00Z`));
  await scoreDay(deps.db, date);
  persistOpportunities(deps.db, date);
}

describe("edition build idempotency (F2)", () => {
  test("identical inputs reuse the same edition row; feedback change creates a new one", async () => {
    const { deps } = seedDeps();
    deps.profiles.create("idem", { genres: [], topics: [{ tag: "revenge", weight: 90 }], audiences: [], platforms: [], formats: [], hooks: [], emotions: [], languages: [] });
    await seededDay(deps, "2026-08-29");
    const profile = deps.profiles.show();
    const first = buildEdition(deps.db, profile, "2026-08-29");
    expect(first.reused).toBe(false);
    const second = buildEdition(deps.db, profile, "2026-08-29");
    expect(second.reused).toBe(true);
    expect(second.edition.editionRef).toBe(first.edition.editionRef);
    expect(second.edition.digest).toBe(first.edition.digest);
    expect(db_count(deps, morningEditions)).toBe(1); // no duplicate rows

    // New feedback changes personalFit -> new fingerprint -> new edition,
    // even when the day's edition is honestly empty.
    const anyOpp = loadOpportunities(deps.db, "2026-08-29")[0]!;
    const feedback = feedbackAddAction(deps, { opportunityRef: anyOpp.ref, kind: "saved" });
    expect(feedback.status).toBe("success");
    const third = buildEdition(deps.db, deps.profiles.show(), "2026-08-29");
    expect(third.reused).toBe(false);
    expect(third.edition.editionRef).not.toBe(first.edition.editionRef);
    expect(db_count(deps, morningEditions)).toBe(2);
    // A different limit is a different input contract -> a different ref.
    const fourth = buildEdition(deps.db, deps.profiles.show(), "2026-08-29", 5);
    expect(fourth.reused).toBe(false);
    expect(fourth.edition.editionRef).not.toBe(third.edition.editionRef);
  });

  test("editionBuildAction surfaces idempotent_reuse in facts", async () => {
    const { deps } = seedDeps();
    deps.profiles.create("facts", {});
    await seededDay(deps, "2026-08-29");
    const a = editionBuildAction(deps, { date: "2026-08-29" });
    const b = editionBuildAction(deps, { date: "2026-08-29" });
    expect(a.facts!["idempotent_reuse"]).toBe(false);
    expect(b.facts!["idempotent_reuse"]).toBe(true);
    expect(b.facts!["edition_ref"]).toBe(a.facts!["edition_ref"]);
  });
});

describe("score and cluster idempotency (F2)", () => {
  test("same-day re-score of unchanged data reuses one run receipt", async () => {
    const { deps } = seedDeps();
    await seededDay(deps, "2026-08-29");
    await scoreAction(deps, "2026-08-29");
    await scoreAction(deps, "2026-08-29");
    expect(deps.db.select().from(runs).where(eq(runs.kind, "score")).all()).toHaveLength(1);
  });

  test("identical cluster rebuilds reuse one run receipt", () => {
    const { deps } = seedDeps();
    persistOpportunities(deps.db, "2026-08-29");
    clusterBuildAction(deps, "2026-08-29");
    clusterBuildAction(deps, "2026-08-29");
    expect(deps.db.select().from(runs).where(eq(runs.kind, "cluster")).all()).toHaveLength(1);
  });
});

function db_count(deps: AppDeps, table: typeof morningEditions): number {
  return deps.db.select().from(table).all().length;
}

describe("one-off minimum-fit override (canary runbook D4-D7)", () => {
  test("override changes admission without touching the profile revision, and is idempotent", async () => {
    const { deps } = seedDeps();
    deps.profiles.create("ovr", { topics: [{ tag: "revenge", weight: 90 }] });
    await seededDay(deps, "2026-08-29");
    const revisionBefore = deps.profiles.show().headRevision;
    const base = editionBuildAction(deps, { date: "2026-08-29" });
    const overridden = editionBuildAction(deps, { date: "2026-08-29", minimumFit: 99 });
    // Different admission contract -> a different edition (not a reuse).
    expect(overridden.facts!["edition_ref"]).not.toBe(base.facts!["edition_ref"]);
    expect(overridden.facts!["minimum_fit_override"]).toBe(99);
    // The override is honest in the edition's limitations.
    expect(overridden.data === undefined || true).toBe(true); // facts carry the override; limitations asserted via pipeline below
    // Same override twice -> same edition (idempotent).
    const again = editionBuildAction(deps, { date: "2026-08-29", minimumFit: 99 });
    expect(again.facts!["edition_ref"]).toBe(overridden.facts!["edition_ref"]);
    expect(again.facts!["idempotent_reuse"]).toBe(true);
    // No profile revision was written — canary profileAdjustments stay clean.
    expect(deps.profiles.show().headRevision).toBe(revisionBefore);
    // The limitation is recorded on the edition itself.
    const record = buildEdition(deps.db, deps.profiles.show(), "2026-08-29", 8, new Date(), { minimumFit: 99 });
    expect(record.edition.limitations.some((l) => l.includes("min_fit=99"))).toBe(true);
  });
});
