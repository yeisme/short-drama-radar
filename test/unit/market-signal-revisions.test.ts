import { expect, test } from "bun:test";
import { openDb } from "../../src/db/client.ts";
import { initializeMarket } from "../../src/market/sources.ts";
import { importCatalog } from "../../src/market/catalog.ts";
import {
  analyzeMarket, correctSignal, reviewWorkIdentity, signalByRef,
} from "../../src/market/signals.ts";
import { workMapping, workSubjectRef } from "../../src/market/identity.ts";
import { buildMarketReview } from "../../src/market/review.ts";
import { marketDigest } from "../../src/market/repository.ts";

test("identity mapping changes append corrections without rewriting signal history", async () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    await importCatalog(db, { source: "dramabox",
      content: "[Same Title](https://www.dramabox.com/drama/123456/boss)",
      format: "markdown", observedAt: "2026-09-10T08:00:00Z", origin: "fixture" });
    const subject = workSubjectRef("dramabox", "123456");
    const analysis = analyzeMarket(db, "2026-09-10T00:00:00Z", "2026-09-11T00:00:00Z");
    const signal = signalByRef(db, analysis.signals.find(s => s.ref.startsWith("signal-"))!.ref)!;
    expect(signal.subject_ref).toBe(subject);
    const evidence = workMapping(db, subject)!.supporting_evidence_refs;
    // Establishing identity (candidate -> verified) is not an identity change:
    // no signal revision is produced.
    const verified = reviewWorkIdentity(db, { work: subject, expected_revision: 1,
      canonical_work_ref: "canonical-1", evidence_refs: evidence }, new Date("2026-09-11T09:00:00Z"));
    expect(verified.identity_changed).toBe(false);
    expect(verified.signal_revisions).toEqual([]);
    expect(signalByRef(db, signal.signal_ref)).toEqual(signal);
    // Moving the verified canonical ref to another work changes the subject
    // interpretation: affected signal heads get a correction revision.
    const revised = reviewWorkIdentity(db, { work: subject, expected_revision: 2,
      canonical_work_ref: "canonical-2", evidence_refs: evidence }, new Date("2026-09-12T09:00:00Z"));
    expect(revised.identity_changed).toBe(true);
    expect(revised.mapping.canonical_work_ref).toBe("canonical-2");
    expect(revised.signal_revisions).toEqual([{ ref: signal.signal_ref, revision: 2 }]);
    const correction = signalByRef(db, signal.signal_ref)!;
    expect(correction).toMatchObject({ claim_kind: "correction", lifecycle: "retracted",
      assertion_level: "observed", corrects_revision: 1 });
    expect(correction.evidence_refs).toEqual([...new Set([...signal.evidence_refs, ...evidence])].sort());
    expect(correction.limitations.some(l => l.includes("canonical-1") && l.includes("canonical-2"))).toBe(true);
    expect(signalByRef(db, signal.signal_ref, 1)).toEqual(signal);
    expect(marketDigest(signalByRef(db, signal.signal_ref, 1))).toBe(marketDigest(signal));
    // Replaying the same review returns the stored mapping and adds nothing.
    const replay = reviewWorkIdentity(db, { work: subject, expected_revision: 2,
      canonical_work_ref: "canonical-2", evidence_refs: evidence }, new Date("2026-09-13T09:00:00Z"));
    expect(replay.reused).toBe(true);
    expect(replay.identity_changed).toBe(false);
    expect(signalByRef(db, signal.signal_ref)).toEqual(correction);
    // A failing review leaves both the mapping and the signals untouched.
    expect(() => reviewWorkIdentity(db, { work: subject, expected_revision: 3,
      canonical_work_ref: "canonical-3", evidence_refs: ["missing-evidence"] }, new Date("2026-09-14T09:00:00Z"))).toThrow("stored market evidence");
    expect(workMapping(db, subject)).toEqual(revised.mapping);
    expect(signalByRef(db, signal.signal_ref)).toEqual(correction);
  } finally { db.$client.close(); }
});

test("missing follow-up stays inconclusive and explicit corrections replay idempotently", async () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    await importCatalog(db, { source: "dramabox",
      content: "[Only Work](https://www.dramabox.com/drama/654321/queen)",
      format: "markdown", observedAt: "2026-09-10T08:00:00Z", origin: "fixture" });
    const analysis = analyzeMarket(db, "2026-09-10T00:00:00Z", "2026-09-11T00:00:00Z");
    const original = signalByRef(db, analysis.signals[0].ref)!;
    // No later observation exists: the weekly outcome is inconclusive, never
    // a cooling trend or a failed prediction.
    const review = buildMarketReview(db, "2026-09-10T00:00:00Z", "2026-09-11T00:00:00Z",
      "2026-09-13T08:00:00Z", new Date("2026-09-14T08:00:00Z"));
    const entry = review.review.entries.find(e => e.original.signal_ref === original.signal_ref)!;
    expect(entry.outcome).toBe("inconclusive");
    expect(entry.followup).toBeNull();
    // An explicit owner correction records insufficient evidence honestly.
    const request = { ref: original.signal_ref, expected_revision: 1,
      reason: "Fixture evidence insufficient for this claim.", evidence_refs: original.evidence_refs,
      outcome: "inconclusive" as const, corrected_at: "2026-09-11T09:00:00Z" };
    const corrected = correctSignal(db, request);
    expect(corrected.signal).toMatchObject({ revision: 2, lifecycle: "inconclusive", claim_kind: "correction" });
    expect(corrected.reused).toBe(false);
    expect(correctSignal(db, request).reused).toBe(true);
    expect(() => correctSignal(db, { ...request, reason: "Different correction" })).toThrow("Signal changed");
    expect(signalByRef(db, original.signal_ref, 1)).toEqual(original);
    expect(signalByRef(db, original.signal_ref, 2)).toEqual(corrected.signal);
  } finally { db.$client.close(); }
});
