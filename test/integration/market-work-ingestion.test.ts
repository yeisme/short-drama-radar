import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { openDb } from "../../src/db/client.ts";
import { marketCommand } from "../../src/market/cli.ts";
import { workSubjectRef } from "../../src/market/identity.ts";
import { marketWorkGateDecisions, marketWorkMappings } from "../../src/db/schema.ts";
import { MarketStoreError } from "../../src/market/repository.ts";

const withEpisode = workSubjectRef("hongguo", "7574794690361297951");
const noEpisode = workSubjectRef("hongguo", "7574794690361297950");

function flags(entries: Record<string, string[]> = {}) {
  return new Map(Object.entries(entries));
}
function run(db: ReturnType<typeof openDb>, command: string[], f: Record<string, string[]> = {}) {
  return marketCommand(command, flags(f), db);
}

test("observe-equivalent import, review-batch, reject, override, promote, and old work review stay intact (S04-S09/S12)", async () => {
  const db = openDb(":memory:");
  try {
    await run(db, ["market", "init"]);
    const file = ["test/fixtures/market/hongguo-fields.html"];
    await run(db, ["market", "import-catalog"], { source: ["hongguo"], file, format: ["html"], "observed-at": ["2026-09-10T08:00:00Z"] });
    await run(db, ["market", "import-catalog"], { source: ["hongguo"], file, format: ["html"], "observed-at": ["2026-09-11T08:00:00Z"] });
    const report = await run(db, ["market", "work", "gate", "report"], { source: ["hongguo"] });
    expect((report.data as { verdicts: { promotable: number; rejected: number } }).verdicts).toEqual({ promotable: 2, rejected: 2 });
    const batch = await run(db, ["market", "work", "review-batch"], { source: ["hongguo"], key: ["ingest-1"] });
    const receipt = (batch.data as { receipt: { promotable: number; rejected: number; decision_refs: string[] } }).receipt;
    expect(receipt.promotable).toBe(2);
    expect(receipt.rejected).toBe(2);
    const replay = await run(db, ["market", "work", "review-batch"], { source: ["hongguo"], key: ["ingest-1"] });
    expect((replay.data as { reused: boolean }).reused).toBe(true);
    expect((replay.data as { receipt: { decision_refs: string[] } }).receipt.decision_refs).toEqual(receipt.decision_refs);

    const listed = await run(db, ["market", "work", "show"], { work: [withEpisode] });
    const mapping = listed.data as { mapping_revision: number; supporting_evidence_refs: string[] };
    const promoted = await run(db, ["market", "work", "promote"], {
      work: [withEpisode], revision: [String(mapping.mapping_revision)],
      canonical: ["canonical-ready"], evidence: mapping.supporting_evidence_refs,
    });
    expect((promoted.data as { mapping: { mapping_status: string } }).mapping.mapping_status).toBe("verified");

    const blocked = await run(db, ["market", "work", "show"], { work: [noEpisode] });
    const blockedMapping = blocked.data as { mapping_revision: number; supporting_evidence_refs: string[] };
    await run(db, ["market", "work", "promote"], {
      work: [noEpisode], revision: [String(blockedMapping.mapping_revision)],
      canonical: ["canonical-blocked"], evidence: blockedMapping.supporting_evidence_refs,
    }).then(() => { throw new Error("expected gate_not_passed"); }, (error: MarketStoreError) => {
      expect(error.code).toBe("gate_not_passed");
    });
    const overridden = await run(db, ["market", "work", "promote"], {
      work: [noEpisode], revision: [String(blockedMapping.mapping_revision)],
      canonical: ["canonical-blocked"], evidence: blockedMapping.supporting_evidence_refs,
      "override-reason": ["owner accepts catalog sample without episode_count"],
    });
    expect((overridden.data as { overridden: boolean }).overridden).toBe(true);

    const other = (await run(db, ["market", "work", "list"], { status: ["candidate"] })).data as { works: Array<{ platform_work_ref: string; mapping_revision: number; supporting_evidence_refs: string[] }> };
    const leftover = other.works[0];
    const reviewed = await run(db, ["market", "work", "review"], {
      work: [leftover.platform_work_ref], revision: [String(leftover.mapping_revision)],
      canonical: ["canonical-ungated"], evidence: leftover.supporting_evidence_refs,
    });
    expect((reviewed.data as { mapping: { mapping_status: string } }).mapping.mapping_status).toBe("verified");
    expect(db.select().from(marketWorkMappings).all().some(row => row.status === "verified")).toBe(true);
    expect(db.select().from(marketWorkGateDecisions).all().length).toBeGreaterThan(0);
  } finally { db.$client.close(); }
});
