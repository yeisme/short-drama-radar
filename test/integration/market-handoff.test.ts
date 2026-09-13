import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildMarketHandoffVectors, type MarketHandoffVector } from "../../src/market/handoff.ts";
import { validateEnvelope } from "../../src/output/envelope.ts";

// Task 4.5: the committed market handoff vectors let CLI-less consumers
// (DSH) learn the schema and reconcile receipts. The file must be
// app-generated: regenerating through the services reproduces every digest.

interface HandoffFile {
  spec: string; generated: string; owner: string; regenerate: string; notes: string[]; vectors: MarketHandoffVector[];
}

test("market handoff vectors cover every contract state and validate as envelopes", async () => {
  const file = JSON.parse(readFileSync(join(import.meta.dir, "../../docs/interfaces/market-handoff-vectors.json"), "utf8")) as HandoffFile;
  expect(file.spec).toBe("radar.market.handoff.vectors.v1");
  expect(file.owner).toBe("cli/short-drama-radar");
  expect(file.regenerate).toContain("scripts/generate-market-handoff-vectors.ts");
  const names = file.vectors.map(v => v.name).sort();
  expect(names).toEqual(["blocked", "conflict", "empty", "partial", "ready", "retracted", "stale", "unknown"]);
  const byName = Object.fromEntries(file.vectors.map(v => [v.name, v]));
  // Success vectors and error vectors both validate against the envelope schema.
  for (const vector of file.vectors) {
    expect(validateEnvelope(vector.envelope).problems).toEqual([]);
    expect(vector.envelope.command.startsWith("radar.market.")).toBe(true);
  }
  expect(byName.ready!.envelope.status).toBe("success");
  expect((byName.empty!.envelope.data as { status: string }).status).toBe("empty");
  expect((byName.partial!.envelope.data as { status: string }).status).toBe("degraded");
  expect(byName.stale!.envelope.error!.code).toBe("state_conflict");
  expect(byName.blocked!.envelope.error!.code).toBe("content_blocked");
  expect(byName.conflict!.envelope.error!.code).toBe("idempotency_conflict");
  expect(JSON.stringify(byName.unknown!.envelope.data).toLowerCase()).not.toContain('"us"');
  expect((byName.retracted!.envelope.data as { lifecycle: string }).lifecycle).toBe("retracted");
  // Receipt reconciliation material rides on the stale vector.
  expect(byName.stale!.receipt!.idempotency_key).toBe("handoff-vector-mark");
  expect(byName.stale!.receipt!.payload_digest).toMatch(/^sha256:/);
  // No secrets or raw payloads anywhere in the handoff.
  const blob = JSON.stringify(file).toLowerCase();
  expect(blob).not.toMatch(/cookie|password|bearer |authorization:|secretstore:\/\//);
});

test("regenerating through the services reproduces every committed digest", async () => {
  const file = JSON.parse(readFileSync(join(import.meta.dir, "../../docs/interfaces/market-handoff-vectors.json"), "utf8")) as HandoffFile;
  const regenerated = await buildMarketHandoffVectors();
  expect(regenerated.vectors.map(v => v.name).sort()).toEqual(file.vectors.map(v => v.name).sort());
  const committed = Object.fromEntries(file.vectors.map(v => [v.name, v.digest]));
  for (const vector of regenerated.vectors) {
    expect(vector.digest).toBe(committed[vector.name]);
  }
});
