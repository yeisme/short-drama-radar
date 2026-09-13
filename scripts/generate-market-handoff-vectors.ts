import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildMarketHandoffVectors, MARKET_HANDOFF_VECTOR_SPEC } from "../src/market/handoff.ts";

// Regenerates docs/interfaces/market-handoff-vectors.json from the real
// services. Never edit that file by hand; rerun this script instead.

const { vectors } = await buildMarketHandoffVectors();
const document = {
  spec: MARKET_HANDOFF_VECTOR_SPEC,
  generated: new Date().toISOString().slice(0, 10),
  owner: "cli/short-drama-radar",
  regenerate: "bun run scripts/generate-market-handoff-vectors.ts",
  notes: [
    "Every vector is produced by the market services on a fixture-seeded disposable database; the file is machine-generated, never hand-edited.",
    "ready/empty/partial carry successful read envelopes; stale/blocked/conflict carry named error envelopes; unknown exposes explicit unknown markets; retracted shows an immutable correction revision.",
    "The stale vector carries the reconciliation receipt of the earlier successful reader mutation for key-based recovery.",
  ],
  vectors,
};
const target = join(import.meta.dir, "../docs/interfaces/market-handoff-vectors.json");
writeFileSync(target, JSON.stringify(document, null, 2) + "\n");
console.log(`wrote ${vectors.length} market handoff vectors to ${target}`);
