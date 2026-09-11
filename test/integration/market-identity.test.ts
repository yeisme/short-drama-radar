import { expect, test } from "bun:test";
import { openDb } from "../../src/db/client.ts";
import { listWorkMappings, reviewWorkMapping, saveWorkCandidate, workMapping, workSubjectRef } from "../../src/market/identity.ts";
import { initializeMarket } from "../../src/market/sources.ts";
import { importCatalog } from "../../src/market/catalog.ts";
import { analyzeMarket, signalByRef } from "../../src/market/signals.ts";
import { crossMarketView } from "../../src/market/cross-market.ts";

test("same titles remain separate candidates and revisions remain readable", () => {
  const db = openDb(":memory:");
  try {
    const first = { platform_work_ref: "work-a", canonical_work_ref: null,
      original_title: "Same Title", aliases: [], mapping_revision: 1,
      mapping_status: "candidate", supporting_evidence_refs: [] };
    saveWorkCandidate(db, first, 0);
    saveWorkCandidate(db, { ...first, platform_work_ref: "work-b" }, 0);
    saveWorkCandidate(db, { ...first, mapping_revision: 2, aliases: ["同名"] }, 1);
    expect(workMapping(db, "work-a", 1)?.aliases).toEqual([]);
    expect(workMapping(db, "work-a")?.aliases).toEqual(["同名"]);
    expect(workMapping(db, "work-b")?.canonical_work_ref).toBeNull();
    expect(() => saveWorkCandidate(db, { ...first, aliases: ["陈旧"] }, 0)).toThrow("revision changed");
    expect(() => saveWorkCandidate(db, { ...first, platform_work_ref: "work-c", supporting_evidence_refs: ["missing"] }, 0)).toThrow("stored market evidence");
    expect(() => saveWorkCandidate(db, { ...first, mapping_status: "verified", canonical_work_ref: "canonical-1", supporting_evidence_refs: ["fake"] }, 0)).toThrow("explicit identity review");
  } finally { db.$client.close(); }
});

test("catalog imports keep same-title works separate and refresh candidates idempotently", async () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    const dramabox = "[Same Title](https://www.dramabox.com/drama/123456/boss)\n[Other Work](https://www.dramabox.com/drama/234567/queen)";
    const first = await importCatalog(db, { source: "dramabox", content: dramabox,
      format: "markdown", observedAt: "2026-09-10T08:00:00Z", origin: "fixture" });
    expect(first.work_candidates_created).toBe(2);
    const reelshort = await importCatalog(db, { source: "reelshort",
      content: "[Same Title](https://www.reelshort.com/movie/same-title-aabbccddeeff001122334455)",
      format: "markdown", observedAt: "2026-09-10T08:00:00Z", origin: "fixture" });
    expect(reelshort.work_candidates_created).toBe(1);
    const works = listWorkMappings(db);
    expect(works).toHaveLength(3);
    expect(works.every(m => m.mapping_status === "candidate" && m.canonical_work_ref === null)).toBe(true);
    // Same title on two sources stays two identities (S08).
    expect(works.filter(m => m.original_title === "Same Title")).toHaveLength(2);
    const subject = workSubjectRef("dramabox", "123456");
    expect(works.some(m => m.platform_work_ref === subject)).toBe(true);
    expect(works.every(m => m.supporting_evidence_refs.length > 0)).toBe(true);
    // Replaying the same batch must not advance any mapping revision.
    const replay = await importCatalog(db, { source: "dramabox", content: dramabox,
      format: "markdown", observedAt: "2026-09-10T08:00:00Z", origin: "fixture" });
    expect(replay.work_candidates_created).toBe(0);
    expect(workMapping(db, subject)?.mapping_revision).toBe(1);
    // A later snapshot with a changed title advances the candidate while the
    // earlier revision keeps its original recorded title.
    await importCatalog(db, { source: "dramabox", content: "[Retitled](https://www.dramabox.com/drama/123456/boss)",
      format: "markdown", observedAt: "2026-09-11T08:00:00Z", origin: "fixture" });
    expect(workMapping(db, subject)?.original_title).toBe("Retitled");
    expect(workMapping(db, subject, 1)?.original_title).toBe("Same Title");
  } finally { db.$client.close(); }
});

test("owner review verifies identity immutably and later imports never demote it", async () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    await importCatalog(db, { source: "dramabox",
      content: "[Same Title](https://www.dramabox.com/drama/123456/boss)",
      format: "markdown", observedAt: "2026-09-10T08:00:00Z", origin: "fixture" });
    await importCatalog(db, { source: "reelshort",
      content: "[Same Title](https://www.reelshort.com/movie/same-title-aabbccddeeff001122334455)",
      format: "markdown", observedAt: "2026-09-10T08:00:00Z", origin: "fixture" });
    const left = workSubjectRef("dramabox", "123456");
    const right = workSubjectRef("reelshort", "aabbccddeeff001122334455");
    const evidence = workMapping(db, left)!.supporting_evidence_refs;
    expect(() => reviewWorkMapping(db, { work: left, expected_revision: 1,
      canonical_work_ref: "canonical-1", evidence_refs: ["missing"] })).toThrow("stored market evidence");
    expect(() => reviewWorkMapping(db, { work: left, expected_revision: 1,
      canonical_work_ref: "", evidence_refs: evidence })).toThrow();
    expect(() => reviewWorkMapping(db, { work: "work-missing", expected_revision: 1,
      canonical_work_ref: "canonical-1", evidence_refs: evidence })).toThrow("No work mapping");
    const reviewed = reviewWorkMapping(db, { work: left, expected_revision: 1,
      canonical_work_ref: "canonical-1", evidence_refs: evidence });
    expect(reviewed.reused).toBe(false);
    expect(reviewed.mapping).toMatchObject({ mapping_status: "verified",
      canonical_work_ref: "canonical-1", mapping_revision: 2 });
    expect(reviewed.mapping.original_title).toBe("Same Title");
    // Identical replay returns the stored revision; a different canonical
    // ref under the same expectation conflicts instead of overwriting.
    expect(reviewWorkMapping(db, { work: left, expected_revision: 1,
      canonical_work_ref: "canonical-1", evidence_refs: evidence }).reused).toBe(true);
    expect(() => reviewWorkMapping(db, { work: left, expected_revision: 1,
      canonical_work_ref: "canonical-2", evidence_refs: evidence })).toThrow("revision changed");
    expect(listWorkMappings(db, "verified")).toHaveLength(1);
    expect(listWorkMappings(db, "candidate")).toHaveLength(1);
    // A later catalog import with a new title must not demote or rewrite the
    // owner-verified mapping.
    await importCatalog(db, { source: "dramabox", content: "[Retitled](https://www.dramabox.com/drama/123456/boss)",
      format: "markdown", observedAt: "2026-09-11T08:00:00Z", origin: "fixture" });
    expect(workMapping(db, left)).toEqual(reviewed.mapping);
    // Cross-market comparison links the two sides only after both explicit
    // reviews agree on one canonical ref.
    const analysis = analyzeMarket(db, "2026-09-10T00:00:00Z", "2026-09-11T00:00:00Z");
    const signals = analysis.signals.map(s => signalByRef(db, s.ref, s.revision)!);
    const leftSignal = signals.find(s => s.subject_ref === left)!;
    const rightSignal = signals.find(s => s.subject_ref === right)!;
    expect(crossMarketView(db, { signal_ref: leftSignal.signal_ref, revision: 1 },
      { signal_ref: rightSignal.signal_ref, revision: 1 }).identity_relation).toBe("not_established");
    reviewWorkMapping(db, { work: right, expected_revision: 1,
      canonical_work_ref: "canonical-1", evidence_refs: workMapping(db, right)!.supporting_evidence_refs });
    expect(crossMarketView(db, { signal_ref: leftSignal.signal_ref, revision: 1 },
      { signal_ref: rightSignal.signal_ref, revision: 1 }).identity_relation).toBe("verified_same_work");
  } finally { db.$client.close(); }
});
