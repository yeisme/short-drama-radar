import { expect, test } from "bun:test";
import { openDb } from "../../src/db/client.ts";
import { initializeMarket, registerSourceCandidate } from "../../src/market/sources.ts";
import { sourceGaps } from "../../src/market/qualification.ts";

// Synthetic source declarations: no real provider or audience claim.
test.each([["JP", "ja-JP"], ["KR", "ko-KR"]] as const)("%s candidate registration preserves the regional evidence gap", (market, locale) => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    const ref = `synthetic-${market.toLowerCase()}-catalog`;
    const input = { source_ref: ref, publisher_group: ref, locale, markets: [market] };
    const source = registerSourceCandidate(db, input).source;
    expect(source.readiness).toBe("planned");
    expect(source.locale).toBe(locale);
    expect(registerSourceCandidate(db, input).reused).toBe(true);
    const gaps = sourceGaps(db, new Date("2026-09-17T00:00:00Z"));
    const declared = gaps.markets.find(m => m.market === market)!;
    const other = gaps.markets.find(m => m.market === (market === "JP" ? "KR" : "JP"))!;
    expect(declared.declared_sources).toContain(ref);
    expect(declared.verified_sources).not.toContain(ref);
    expect(declared.status).toBe("coverage_unverified");
    expect(other.declared_sources).not.toContain(ref);
  } finally { db.$client.close(); }
});
