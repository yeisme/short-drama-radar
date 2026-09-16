import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { openDb } from "../../src/db/client.ts";
import { marketCommand } from "../../src/market/cli.ts";
import { MarketStoreError } from "../../src/market/repository.ts";
import { CURRENT_GATE_VERSION } from "../../src/market/gate.ts";
import { workSubjectRef } from "../../src/market/identity.ts";
import { marketWorkGateDecisions } from "../../src/db/schema.ts";

const fields = () => readFileSync("test/fixtures/market/hongguo-fields.html", "utf8");
const withEpisode = workSubjectRef("hongguo", "7574794690361297951");

function flags(entries: Record<string, string[]> = {}) {
  return new Map(Object.entries(entries));
}
function run(db: ReturnType<typeof openDb>, command: string[], f: Record<string, string[]> = {}) {
  return marketCommand(command, flags(f), db);
}
async function expectsError(promise: Promise<unknown>, code: string, message?: string) {
  await promise.then(() => { throw new Error("expected " + code); }, (error: MarketStoreError) => {
    expect(error.code).toBe(code);
    if (message) expect(error.message).toContain(message);
  });
}

test("gate show/report are read-only projections with named errors (S03/S05)", async () => {
  const db = openDb(":memory:");
  try {
    await run(db, ["market", "init"]);
    const shown = await run(db, ["market", "work", "gate", "show"]);
    expect(shown.command).toBe("radar.market.work.gate.show");
    expect((shown.data as { gate_version: string }).gate_version).toBe(CURRENT_GATE_VERSION);
    const before = db.select().from(marketWorkGateDecisions).all().length;
    const empty = await run(db, ["market", "work", "gate", "report"], { source: ["hongguo"] });
    expect((empty.data as { evaluated: number }).evaluated).toBe(0);
    expect((empty.data as { verdicts: { promotable: number } }).verdicts.promotable).toBe(0);
    expect(db.select().from(marketWorkGateDecisions).all()).toHaveLength(before);
    await expectsError(run(db, ["market", "work", "gate", "show"], { version: ["nope"] }), "gate_version_unknown");
    await expectsError(run(db, ["market", "work", "gate", "report"], { source: ["not-registered"] }), "source_not_found");
    await expectsError(run(db, ["market", "work", "gate"]), "command_unknown", "gate show");
    await expectsError(run(db, ["market", "work", "gate", "report"], { source: ["hongguo"], verbose: ["true"] }), "flag_invalid");
  } finally { db.$client.close(); }
});

test("review-batch-receipt and gate decisions recover by key and work ref (S07)", async () => {
  const db = openDb(":memory:");
  try {
    await run(db, ["market", "init"]);
    await run(db, ["market", "import-catalog"], {
      source: ["hongguo"], file: ["test/fixtures/market/hongguo-fields.html"], format: ["html"],
      "observed-at": ["2026-09-10T08:00:00Z"],
    });
    await run(db, ["market", "import-catalog"], {
      source: ["hongguo"], file: ["test/fixtures/market/hongguo-fields.html"], format: ["html"],
      "observed-at": ["2026-09-11T08:00:00Z"],
    });
    const batch = await run(db, ["market", "work", "review-batch"], { source: ["hongguo"], key: ["batch-1"] });
    const receipt = (batch.data as { receipt: { idempotency_key: string; decision_refs: string[]; evaluated: number } }).receipt;
    expect(receipt.evaluated).toBe(4);
    expect(receipt.decision_refs.length).toBe(4);
    const shown = await run(db, ["market", "work", "review-batch-receipt"], { key: ["batch-1"] });
    expect((shown.data as { idempotency_key: string }).idempotency_key).toBe("batch-1");
    expect((shown.data as { decision_refs: string[] }).decision_refs).toEqual(receipt.decision_refs);
    const history = await run(db, ["market", "work", "gate", "decisions"], { work: [withEpisode] });
    expect((history.data as { decisions: unknown[] }).decisions).toHaveLength(1);
    await expectsError(run(db, ["market", "work", "review-batch-receipt"], { key: ["missing-key"] }), "receipt_not_found");
    await expectsError(run(db, ["market", "work", "gate", "decisions"]), "value_required", "--work");
  } finally { db.$client.close(); }
});
