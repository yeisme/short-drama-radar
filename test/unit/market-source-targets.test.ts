import { expect, test } from "bun:test";
import { openDb } from "../../src/db/client.ts";
import { initializeMarket, listSources } from "../../src/market/sources.ts";
import { qualificationReport, sourceGaps } from "../../src/market/qualification.ts";
import { reviewSource, sourceReviewReceipt } from "../../src/market/source-review.ts";
import { sourceByRef } from "../../src/market/repository.ts";
import { marketCommand } from "../../src/market/cli.ts";

// Tasks 1.11-1.21: per-source field qualification and input adaptation for
// the eleven unadapted targets. Every candidate keeps a ledger entry with a
// dated, concrete sampling gap, `source qualify` returns that specific
// receipt, and an owner blocked review freezes the decision without removing
// the source from the ledger. Research notes alone never promote readiness.

const NOW = new Date("2026-09-17T00:00:00Z");

// One concrete per-source gap keyword: the qualification receipt must carry
// the entry finding, not a generic placeholder.
const TARGETS: { ref: string; gap: string; blockedReason: string }[] = [
  { ref: "hongguo-animation", gap: "must not imply AI production",
    blockedReason: "App-only animation entry; no public web work catalog to sample." },
  { ref: "huolong", gap: "not collection receipts",
    blockedReason: "New-release, catalog and ranking surfaces lack verified public work-level entries." },
  { ref: "kuaishou", gap: "risk control",
    blockedReason: "Work-level entry unverified; login and anti-automation restrictions are not bypassed." },
  { ref: "xifan", gap: "store introduction is not work-level observation",
    blockedReason: "Stable work identity and catalog sampling range unverified." },
  { ref: "netshort", gap: "must not be mapped to MX/BR audience markets",
    blockedReason: "No region-level work performance data; language does not establish audience markets." },
  { ref: "melolo", gap: "store availability is not audience heat",
    blockedReason: "Work-level fields and Indonesia market evidence unverified." },
  { ref: "dramawave", gap: "extraction failed",
    blockedReason: "Official site not extractable; no public alternative or permission dependency verified." },
  { ref: "pinedrama", gap: "never counts as independent corroboration",
    blockedReason: "Publisher-group, work and region bases each require independent verification." },
  { ref: "kukutv", gap: "not trend data",
    blockedReason: "Local-language works, work data and India market basis unverified." },
  { ref: "quicktv", gap: "denominators stay separate from other sources",
    blockedReason: "Stable IDs, topics and India sampling range unverified." },
  { ref: "bilibili", gap: "must not masquerade as consumption rankings",
    blockedReason: "Discussion, reposts, works and metrics not separated by a verified entry point." },
];

test("each unadapted target seeds a concrete dated gap and stays planned", () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    const byRef = new Map(listSources(db).map(source => [source.source_ref, source]));
    expect(byRef.size).toBe(18);
    for (const target of TARGETS) {
      const source = byRef.get(target.ref)!;
      // Research notes never promote readiness, and audience geography stays
      // unknown until work-level evidence exists.
      expect(source.readiness).toBe("planned");
      expect(source.market_scope).toEqual(["unknown"]);
      expect(source.official_identity_evidence).toEqual([]);
      expect(source.sampling_scope.startsWith("Pending:")).toBe(true);
      expect(source.limitations.length).toBeGreaterThanOrEqual(2);
      expect(source.limitations.some(line => line.includes(target.gap))).toBe(true);
      // Every limitation documents the entry review date so the blocked
      // receipt stays auditable instead of open-ended.
      expect(source.limitations.some(line => line.includes("2026-09-11"))).toBe(true);
    }
  } finally { db.$client.close(); }
});

test("source qualify returns the specific blocked receipt for every target", () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    for (const target of TARGETS) {
      const report = qualificationReport(db, target.ref, NOW);
      expect(report.qualified).toBe(false);
      expect(report.configured_readiness).toBe("planned");
      expect(report.health).toBe("unavailable");
      expect(report.reasons).toContain("identity_evidence_missing");
      expect(report.reasons).toContain("non_fixture_sample_missing");
      expect(report.reasons).toContain("seven_complete_live_days_missing");
      expect(report.reasons).toContain("sampling_plan_not_preregistered");
      expect(report.reasons).toContain("sample_review_required");
      // The receipt carries the concrete per-source gap, not a placeholder.
      expect(report.limitations.some(line => line.includes(target.gap))).toBe(true);
    }
  } finally { db.$client.close(); }
});

test("owner blocked review freezes the decision and keeps the source in the ledger", () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    for (const target of TARGETS) {
      const input = { key: "blocked-" + target.ref, source_ref: target.ref, revision: 1,
        stage: "blocked" as const, reason: target.blockedReason, evidence_refs: [] };
      const review = reviewSource(db, input, NOW);
      expect(review.reused).toBe(false);
      expect(review.receipt.source.readiness).toBe("blocked");
      expect(review.receipt.source.revision).toBe(2);
      // Replay is idempotent; a conflicting reason under the same key is refused.
      expect(reviewSource(db, input, NOW).reused).toBe(true);
      expect(() => reviewSource(db, { ...input, reason: "Changed." }, NOW)).toThrow("different parameters");
      expect(sourceReviewReceipt(db, input.key).source.readiness).toBe("blocked");
      const report = qualificationReport(db, target.ref, NOW);
      expect(report.configured_readiness).toBe("blocked");
      expect(report.reasons).toContain("source_blocked");
      // The blocked reason stays visible in the receipt limitations.
      expect(report.limitations.some(line => line.includes(target.blockedReason))).toBe(true);
    }
    // A blocked source never disappears from the ledger and never counts as
    // a verified market source.
    const gaps = sourceGaps(db, NOW);
    const blockedRefs = new Set(TARGETS.map(target => target.ref));
    expect(gaps.sources.filter(source => blockedRefs.has(source.source_ref))
      .every(source => source.configured_readiness === "blocked")).toBe(true);
    for (const market of gaps.markets) {
      expect(market.verified_sources).toEqual([]);
    }
  } finally { db.$client.close(); }
});

test("CLI qualify replays the concrete receipt for a representative target", async () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    const result = await marketCommand(["market", "source", "qualify"],
      new Map(Object.entries({ source: ["hongguo-animation"] })), db);
    const report = result.data as ReturnType<typeof qualificationReport>;
    expect(report.source_ref).toBe("hongguo-animation");
    expect(report.qualified).toBe(false);
    expect(report.limitations.some(line => line.includes("must not imply AI production"))).toBe(true);
  } finally { db.$client.close(); }
});
