import { cpus, totalmem, arch, platform } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/client.ts";
import { initializeMarket } from "../src/market/sources.ts";
import { saveObservationBatch } from "../src/market/repository.ts";
import { analyzeMarket } from "../src/market/signals.ts";
import { buildMarketBrief, readMarketBrief } from "../src/market/brief.ts";
import { catchUp } from "../src/market/catchup.ts";
import type { MarketObservation } from "../src/market/domain.ts";

// Task 5.2: local read-performance measurement on a fixed fixture
// (100k observations / 10k signals / 30 days). Reads must stay under the
// 1s p95 budget with no network or model waits; this script never starts a
// second service. Run through the evidence runner:
//   bun run scripts/integration-test-run.ts -- bun run scripts/market-perf.ts

const WORKS = 10_000;
const DAYS = 10; // 10 observations per work -> 100k observations
const END_DAY = "2026-09-23T00:00:00Z"; // every work's final observation day
const READS = 50;
const P95_BUDGET_MS = 1_000;

function observation(ref: string, item: string, day: string, value: number): MarketObservation {
  const prev = new Date(Date.parse(day + "T00:00:00Z") - 86400000).toISOString().slice(0, 10);
  return {
    spec: "radar.market_observation.v1", observation_ref: ref,
    source_ref: "hongguo", source_revision: 1, source_item_id: item,
    source_snapshot_ref: "snapshot-" + ref, observed_at: day + "T08:00:00Z", source_published_at: null,
    market: "unknown", market_evidence_refs: [], locale: "zh", format: "unknown",
    production_method: "unknown", production_evidence_refs: [], title: "Perf fixture " + item,
    topics: ["suspense"], facts: [{ name: "engagement", value, unit: "count", basis: "interval",
      window: { start: prev + "T00:00:00Z", end: day + "T00:00:00Z" }, definition_version: "v1", sample_denominator: null }],
    evidence_refs: ["evidence-" + ref], collection_run_ref: "run-perf", origin: "fixture",
  };
}

function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
}

const dir = mkdtempSync(join(tmpdir(), "radar-market-perf-"));
const db = openDb(join(dir, "perf.db"));
try {
  initializeMarket(db);
  const seedStart = Date.now();
  // All works end on END_DAY; earlier observations stretch back across the
  // 30-day window, staggered so batches stay day-homogeneous.
  const byDay = new Map<string, MarketObservation[]>();
  for (let w = 0; w < WORKS; w++) {
    for (let d = 0; d < DAYS; d++) {
      const day = new Date(Date.parse(END_DAY) - (DAYS - 1 - d) * 86400000).toISOString().slice(0, 10);
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day)!.push(observation("po-" + w + "-" + d, "pw-" + w, day, 100 + d * 10 + (w % 7)));
    }
  }
  let seeded = 0;
  for (const [day, observations] of byDay) {
    for (let i = 0; i < observations.length; i += 1000) {
      saveObservationBatch(db, { ref: "pb-" + day + "-" + i, source_ref: "hongguo", source_revision: 1,
        observed_at: day + "T08:00:00Z", origin: "fixture", observations: observations.slice(i, i + 1000) });
    }
    seeded += observations.length;
  }
  const seedMs = Date.now() - seedStart;

  const analyzeStart = Date.now();
  const analysis = analyzeMarket(db, "2026-09-23T00:00:00Z", "2026-09-24T00:00:00Z");
  const analyzeMs = Date.now() - analyzeStart;

  const buildStart = Date.now();
  buildMarketBrief(db, "2026-09-23T00:00:00Z", "2026-09-24T00:00:00Z", new Date("2026-09-24T09:00:00Z"));
  const buildMs = Date.now() - buildStart;

  // Read measurements: cold = first execution, hot = the following runs.
  const briefTimes: number[] = [];
  let briefCold = 0;
  for (let i = 0; i < READS; i++) {
    const start = performance.now();
    const projection = readMarketBrief(db);
    const elapsed = performance.now() - start;
    if (i === 0) briefCold = elapsed; else briefTimes.push(elapsed);
    if (projection.main.length < 0) throw new Error("unreachable");
  }
  const catchupTimes: number[] = [];
  let catchupCold = 0;
  for (let i = 0; i < READS; i++) {
    const start = performance.now();
    const page = catchUp(db, { limit: 20, now: new Date("2026-09-24T10:00:00Z") });
    const elapsed = performance.now() - start;
    if (i === 0) catchupCold = elapsed; else catchupTimes.push(elapsed);
    if (page.signals.length !== 20 && i === 0) throw new Error("catchup first page must return 20 items");
  }

  const briefP95 = p95(briefTimes), catchupP95 = p95(catchupTimes);
  const report = {
    spec: "radar.market_perf.v1",
    fixture: { observations: seeded, signal_revisions: analysis.signals.length, distinct_signal_refs: new Set(analysis.signals.map(s => s.ref)).size, window_days: 30 },
    environment: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model ?? "unknown", cores: cpus().length, total_mem_gb: Math.round(totalmem() / 2**30), note: "single local process; SQLite file DB; no network or model calls" },
    timings_ms: { seed: seedMs, analyze_last_day: analyzeMs, brief_build: buildMs },
    reads: {
      latest_brief: { cold_ms: Number(briefCold.toFixed(1)), p95_ms: Number(briefP95.toFixed(1)), samples: briefTimes.length, main_entries: readMarketBrief(db).main.length },
      catchup_20: { cold_ms: Number(catchupCold.toFixed(1)), p95_ms: Number(catchupP95.toFixed(1)), samples: catchupTimes.length, page_size: 20 },
    },
    budget: { p95_max_ms: P95_BUDGET_MS },
    pass: briefP95 < P95_BUDGET_MS && catchupP95 < P95_BUDGET_MS,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exit(1);
} finally {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
}
