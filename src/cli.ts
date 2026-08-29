#!/usr/bin/env bun
import { loadConfig, ensureRadarHome } from "./config.ts";
import { openDb } from "./db/client.ts";
import { runs } from "./db/schema.ts";
import { collect, defaultAdapters } from "./pipeline/collect.ts";
import { scoreDay } from "./pipeline/scoring.ts";
import { buildCard, type CardPayload } from "./pipeline/card.ts";
import { envelope } from "./output/envelope.ts";

// Commands: doctor | collect | score | card | run | runs
// Default output: human summary. --json emits the stable envelope.
async function main(): Promise<void> {
  const [command = "help", ...rest] = process.argv.slice(2);
  const flags = new Set(rest.filter((a) => a.startsWith("--")));
  const args = rest.filter((a) => !a.startsWith("--"));
  const asJson = flags.has("--json");
  const cfg = loadConfig();
  ensureRadarHome();
  const db = openDb(cfg.dbPath);

  const emit = (data: unknown, errors: string[] = []) => {
    if (asJson) console.log(JSON.stringify(envelope(command, data, errors), null, 2));
    else console.log(renderHuman(command, data, errors));
  };

  switch (command) {
    case "doctor": {
      const checks: Record<string, string> = {};
      try {
        const res = await fetch(`${cfg.firecrawlBaseUrl}/v1/search`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: "ping", limit: 1 }),
          signal: AbortSignal.timeout(10_000),
        });
        checks.firecrawl = res.ok ? "ok" : `http ${res.status}`;
      } catch (err) {
        checks.firecrawl = `unreachable: ${(err as Error).message}`;
      }
      const proc = Bun.spawnSync([cfg.agentReachBin, "doctor", "--json"]);
      checks["agent-reach"] = proc.exitCode === 0 ? "ok" : `exit ${proc.exitCode} (xiaohongshu backend likely off)`;
      checks["db-path"] = cfg.dbPath;
      checks["schedule"] = `${cfg.schedule.collect1}/${cfg.schedule.collect2} collect, ${cfg.schedule.send} send`;
      emit(checks, Object.values(checks).some((v) => v.startsWith("unreachable") || v.startsWith("exit")) ? ["one or more layers degraded"] : []);
      break;
    }
    case "collect": {
      const summary = await collect(db, defaultAdapters(), {
        firecrawlBaseUrl: cfg.firecrawlBaseUrl,
        agentReachBin: cfg.agentReachBin,
        timeoutMs: 60_000,
        fixtureDir: process.env.RADAR_FIXTURE_DIR,
      });
      recordRun(db, summary.runId, "collect", summary.degradedLayers.length > 0 ? "degraded" : "ok", summary);
      emit(summary);
      break;
    }
    case "score": {
      const date = args[0] ?? new Date().toISOString().slice(0, 10);
      const summary = await scoreDay(db, date);
      recordRun(db, `score-${new Date().toISOString()}`, "score", summary.lowConfidence > 0 ? "degraded" : "ok", summary);
      emit(summary);
      break;
    }
    case "card": {
      const date = args[0] ?? new Date().toISOString().slice(0, 10);
      const card = buildCard(db, date);
      recordRun(db, `card-${new Date().toISOString()}`, "card", card.sourceStatus.degraded ? "degraded" : "ok", {
        items: card.top.douyin.length + card.top.xiaohongshu.length,
      });
      emit(card, card.sourceStatus.notes);
      break;
    }
    case "run": {
      const collectSummary = await collect(db, defaultAdapters(), {
        firecrawlBaseUrl: cfg.firecrawlBaseUrl,
        agentReachBin: cfg.agentReachBin,
        timeoutMs: 60_000,
        fixtureDir: process.env.RADAR_FIXTURE_DIR,
      });
      const date = collectSummary.date;
      const scoreSummary = await scoreDay(db, date);
      const card = buildCard(db, date);
      recordRun(db, `daily-${new Date().toISOString()}`, "daily", card.sourceStatus.degraded ? "degraded" : "ok", {
        collect: collectSummary,
        score: scoreSummary,
      });
      emit(card, [...collectSummary.errors, ...card.sourceStatus.notes]);
      break;
    }
    case "runs": {
      emit(db.select().from(runs).orderBy(runs.id).all().slice(-20));
      break;
    }
    default: {
      console.log(`short-drama-radar — crawler-first daily short-drama intelligence

Usage: radar <command> [--json]

Commands:
  doctor   Check firecrawl / agent-reach / db readiness
  collect  Fetch all layers and upsert today's items
  score    [date] Compute v0 scores for a day
  card     [date] Build Top5+Top5 card payload (contract short-drama-radar.card.v1)
  run      Full daily pipeline: collect -> score -> card
  runs     List recent run receipts

Env:
  RADAR_HOME          User-level state dir (default ~/.short-drama-radar)
  RADAR_DB_PATH       Override DB path
  RADAR_FIXTURE_DIR   Feed fixture markdown instead of live firecrawl (tests)
`);
    }
  }
}

function recordRun(db: ReturnType<typeof openDb>, id: string, kind: string, status: string, summary: unknown): void {
  db.insert(runs).values({
    id,
    kind,
    startedAt: id,
    finishedAt: new Date().toISOString(),
    status,
    summaryJson: JSON.stringify(summary),
  }).run();
}

function renderHuman(command: string, data: unknown, errors: string[]): string {
  const lines = [`== radar ${command} ==`];
  if (typeof data === "object" && data !== null) {
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      lines.push(`${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`);
    }
  } else {
    lines.push(String(data));
  }
  for (const e of errors) lines.push(`warning: ${e}`);
  return lines.join("\n");
}

await main();
