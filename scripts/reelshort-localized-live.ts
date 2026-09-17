#!/usr/bin/env bun
// Explicit live CLI smoke; writes only to a new isolated local research home.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { runWithEvidence, redactEvidence } from "./integration-test-run.ts";
import { validateEnvelope } from "../src/output/envelope.ts";

const root = join(import.meta.dir, "..");
const args = process.argv.slice(2);
if (!args.includes("--confirm-live") || args.some(a => !["--confirm-live", "--execute"].includes(a))) {
  process.stderr.write("Usage: bun run scripts/reelshort-localized-live.ts --confirm-live\nReads the public Japanese and Korean catalogs and keeps a new isolated Radar home plus receipts.\n"); process.exit(2);
}
if (!args.includes("--execute")) {
  const result = runWithEvidence({ command: process.execPath, args: ["run", "scripts/reelshort-localized-live.ts", "--confirm-live", "--execute"], cwd: root });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr);
  process.stderr.write(`[evidence] ${relative(root, result.directory)}\n`); process.exit(result.exitCode);
}
mkdirSync(join(root, "temp"), { recursive: true });
const home = mkdtempSync(join(root, "temp/reelshort-localized-live-"));
let step = 0;
function invoke(...words: string[]) {
  const result = spawnSync(process.execPath, ["run", "src/cli.ts", "market", ...words, "--json"], { cwd: root, encoding: "utf8", timeout: 60000,
    env: { ...process.env, RADAR_HOME: home, RADAR_DB_PATH: join(home, "radar.db"), RADAR_CONFIG_PATH: join(home, "config.json") } });
  const output = redactEvidence(result.stdout ?? "");
  writeFileSync(join(home, `${++step}-${words.slice(0, 2).join("-")}.json`), output);
  let envelope;
  try { envelope = JSON.parse(output); } catch { throw new Error("cli_output_invalid"); }
  if (!validateEnvelope(envelope).ok || result.status !== 0) {
    const code = String(envelope.error?.code ?? "cli_failed");
    throw new Error(/^[a-z_]+$/.test(code) ? code : "cli_failed");
  }
  return envelope.data;
}
try {
  invoke("init");
  const start = new Date().toISOString();
  const samples = [];
  for (const [language, market] of [["ja", "JP"], ["ko", "KR"]]) {
    const source = `reelshort-${language}`;
    invoke("source", "register-candidate", "--source", source, "--publisher-group", "reelshort", "--locale", language!, "--market", market!,
      "--note", "Language-targeted directory sample; audience geography and work format remain unknown.");
    const sample = invoke("observe", "--source", source, "--mode", "verify-sample", "--confirm-live");
    if (sample.origin !== "live" || sample.items < 1 || sample.readiness_unchanged !== "planned") throw new Error("live_sample_invalid");
    samples.push({ source, items: sample.items, batch_ref: sample.batch_ref ?? sample.ref, field_coverage: sample.field_coverage });
    const qualification = invoke("source", "qualify", "--source", source);
    if (qualification.qualified) throw new Error("unexpected_qualification");
  }
  const end = new Date().toISOString();
  const works = invoke("work", "list");
  const analysis = invoke("analyze", "--start", start, "--end", end);
  const brief = invoke("brief", "build", "--start", start, "--end", end);
  const readback = invoke("brief", "show");
  if (brief.brief_ref !== readback.brief_ref) throw new Error("brief_readback_mismatch");
  const report = { scope: "real_public_catalog_sample_not_audience_or_market_validation", home: relative(root, home), samples,
    analysis, brief_ref: brief.brief_ref, brief_status: brief.status, works };
  writeFileSync(join(home, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ home: relative(root, home), samples, brief_ref: brief.brief_ref, brief_status: brief.status }));
} catch (error) {
  console.error(JSON.stringify({ home: relative(root, home), status: "failed", code: error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "live_check_failed" }));
  process.exitCode = 1;
}
