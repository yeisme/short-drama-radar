import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { RadarDb } from "../db/client.ts";
import { openDb } from "../db/client.ts";
import { initializeMarket, updateSettings } from "./sources.ts";
import { importCatalog } from "./catalog.ts";
import { analyzeMarket, correctSignal } from "./signals.ts";
import { buildMarketBrief } from "./brief.ts";
import { catchUp, } from "./catchup.ts";
import { changeReadState, readReader } from "./reader.ts";
import { marketReadPolicy } from "./policy.ts";
import { marketCommand } from "./cli.ts";
import { marketBriefs, marketEvidence, marketSignals } from "../db/schema.ts";
import { MarketStoreError } from "./repository.ts";
import { renderJsonEnvelope, type CommandResult } from "../output/envelope.ts";

// Task 4.5: CLI/service-generated market handoff vectors. Consumers without a
// local radar CLI read these envelopes to learn the schema and reconcile
// receipts. Every vector is produced by the real services on a fixture-seeded
// disposable database — nothing here is hand-authored machine data.

export type MarketHandoffVectorName =
  | "ready" | "empty" | "partial" | "stale" | "blocked" | "conflict" | "unknown" | "retracted";

export interface MarketHandoffVector {
  name: MarketHandoffVectorName;
  command: string;
  purpose: string;
  envelope: ReturnType<typeof renderJsonEnvelope>;
  receipt?: { spec: string; idempotency_key: string; payload_digest: string; reader_revision: number };
  digest: string;
}

export const MARKET_HANDOFF_VECTOR_SPEC = "radar.market.handoff.vectors.v1";

function digestOf(vector: Omit<MarketHandoffVector, "digest">): string {
  return "sha256:" + createHash("sha256").update(JSON.stringify(vector)).digest("hex");
}

async function envelope(db: RadarDb, command: string[], flags: Record<string, string[]>): Promise<ReturnType<typeof renderJsonEnvelope>> {
  try {
    const result = await marketCommand(command, new Map(Object.entries(flags)), db) as CommandResult;
    return renderJsonEnvelope(result);
  } catch (error) {
    if (!(error instanceof MarketStoreError)) throw error;
    // The CLI error path renders exactly this failed envelope shape.
    const failed: CommandResult = { command: "radar.market." + command.slice(1).join("."),
      status: "failed", summary: "failed", error: { code: error.code, message: error.message }, exitCode: 1 };
    return renderJsonEnvelope(failed);
  }
}

export async function buildMarketHandoffVectors(): Promise<{ spec: typeof MARKET_HANDOFF_VECTOR_SPEC; vectors: MarketHandoffVector[] }> {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    await importCatalog(db, { source: "dramabox", content: readFileSync(join(import.meta.dir, "../../test/fixtures/market/dramabox.md"), "utf8"),
      format: "markdown", observedAt: "2026-09-10T08:00:00Z", origin: "fixture" });
    await importCatalog(db, { source: "reelshort", content: readFileSync(join(import.meta.dir, "../../test/fixtures/market/reelshort.html"), "utf8"),
      format: "html", observedAt: "2026-09-11T08:00:00Z", origin: "fixture" });
    analyzeMarket(db, "2026-09-10T00:00:00Z", "2026-09-12T00:00:00Z");
    const signals = db.select().from(marketSignals).all().map(r => r.payload);
    const vectors: MarketHandoffVector[] = [];
    const add = async (name: MarketHandoffVectorName, command: string[], flags: Record<string, string[]>, purpose: string,
      receipt?: MarketHandoffVector["receipt"]) => {
      const env = await envelope(db, command, flags);
      const core = { name, command: "radar.market." + command.slice(1).join("."), purpose, envelope: env, ...(receipt ? { receipt } : {}) };
      vectors.push({ ...core, digest: digestOf(core) });
    };

    // partial: fixture-seeded brief with named coverage gaps (degraded).
    const partialBrief = buildMarketBrief(db, "2026-09-10T00:00:00Z", "2026-09-12T00:00:00Z", new Date("2026-09-12T09:00:00Z")).brief;
    await add("partial", ["market", "brief", "show"], { brief: [partialBrief.brief_ref] },
      "Fixture-seeded brief: degraded coverage with named source gaps; consumers render partial states without inventing data.");
    // empty: a window with no signals is a legitimate zero-entry brief.
    buildMarketBrief(db, "2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z", new Date("2026-09-02T09:00:00Z"));
    const emptyRef = db.select().from(marketBriefs).all().find(row => row.payload.status === "empty")!.payload.brief_ref;
    await add("empty", ["market", "brief", "show"], { brief: [emptyRef] },
      "Empty window brief: zero entries is a legitimate state, never padded.");
    // ready: the ready read path returns unread revisions without side
    // effects. Called with a fixed clock so the vector digest is stable.
    const catchupEnvelope = renderJsonEnvelope({ command: "radar.market.reader.catchup", status: "success",
      summary: "Market reader catchup completed.",
      data: catchUp(db, { now: new Date("2026-09-12T11:00:00Z"), limit: 20 }),
      facts: { external_collection: false },
      actions: [{ name: "sources", command: "radar market source list" }], exitCode: 0 });
    const readyCore = { name: "ready" as const, command: "radar.market.reader.catchup",
      purpose: "Ready read path: explicit catch-up returns unread signal revisions without side effects.",
      envelope: catchupEnvelope };
    vectors.push({ ...readyCore, digest: digestOf(readyCore) });
    // unknown: cross-market comparison keeps unknown markets explicit.
    const left = signals.find(s => s.source_ref === "dramabox")!;
    const right = signals.find(s => s.source_ref === "reelshort")!;
    await add("unknown", ["market", "compare"], { left: [left.signal_ref], "left-revision": ["1"], right: [right.signal_ref], "right-revision": ["1"] },
      "Unknown markets stay explicit; language never implies geography and no shared axis is computed.");
    // A successful reader mutation carries the reconciliation receipt.
    const reader = readReader(db), policy = marketReadPolicy(db);
    const markInput = { action: "mark" as const, idempotency_key: "handoff-vector-mark",
      expected_revision: reader.revision, policy_revision: policy.policy_revision,
      signals: [{ ref: left.signal_ref, revision: 1 }] };
    const mark = changeReadState(db, markInput);
    const receipt = { spec: mark.spec, idempotency_key: mark.idempotency_key,
      payload_digest: mark.payload_digest, reader_revision: mark.reader_revision };
    // retracted: a correction mints an immutable retracted revision.
    db.insert(marketEvidence).values({ ref: "evidence-handoff-retraction", sourceRef: "dramabox",
      observedAt: "2026-09-11T08:00:00Z",
      payload: { title: "Retraction evidence", public_url: "", source_item_id: "w", origin: "fixture" } }).run();
    const corrected = correctSignal(db, { ref: left.signal_ref, expected_revision: 1, reason: "handoff vector retraction",
      evidence_refs: ["evidence-handoff-retraction"], outcome: "retracted", corrected_at: "2026-09-12T10:00:00Z" });
    await add("retracted", ["market", "signal", "show"], { signal: [left.signal_ref], revision: [String(corrected.signal.revision)] },
      "A correction mints a new immutable revision with lifecycle retracted; the old revision stays readable.");
    // stale: policy change invalidates writes signed with the old revision.
    updateSettings(db, 1, { blocked_topics: ["revenge"] });
    await add("stale", ["market", "reader", "mark"], { signal: [right.signal_ref], "signal-revision": ["1"],
      revision: [String(markInput.expected_revision)], "policy-revision": [markInput.policy_revision], key: ["handoff-vector-stale"] },
      "After a policy revision, writes signed with the old policy revision conflict; clients must re-read.",
      receipt);
    // blocked: blocked/unclassified content refuses without echoing content.
    await add("blocked", ["market", "question", "context"], { signal: [right.signal_ref], revision: ["1"], question: ["Why?"] },
      "Blocked or unclassified content returns a safe refusal without echoing content.");
    // conflict: idempotency key reuse with different parameters is refused.
    await add("conflict", ["market", "reader", "mark"], { signal: [right.signal_ref], "signal-revision": ["1"],
      revision: [String(readReader(db).revision)], "policy-revision": [marketReadPolicy(db).policy_revision], key: [mark.idempotency_key] },
      "Reusing an idempotency key with different parameters is refused; the original receipt stays authoritative.");
    return { spec: MARKET_HANDOFF_VECTOR_SPEC, vectors };
  } finally { db.$client.close(); }
}
