#!/usr/bin/env bun
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { runWithEvidence } from "./integration-test-run.ts";
import { validateEnvelope } from "../src/output/envelope.ts";

const root = join(import.meta.dir, "..");
const change = "radar-reelshort-ja-ko-sampling-v1";
const directory = join(root, "openspec/changes", change);
const tasksPath = join(directory, "tasks.md");
const args = process.argv.slice(2);
const tasks = [
  "1.1 实现本地化链接边界和原文标题；owner=radar；依赖=真实页面形态；验收=原文/编码链接去重、跨语言及外链拒绝、旧来源不变；验证=market-reelshort-localized 集成测试。",
  "1.2 接通 observe 与质量记录；owner=radar；依赖=1.1；验收=显式 live、生产资格门、未知字段、幂等和异常脱敏；验证=market-reelshort-localized 集成测试。",
  "1.3 真实 CLI 演练；owner=radar；依赖=1.2；验收=两来源真实样本、作品列表和简报读回，不提升 readiness；验证=bun run scripts/reelshort-localized-live.ts --confirm-live。",
  "1.4 软件收口；owner=radar；依赖=1.1–1.3；验收=typecheck、含真实 PG 的全量测试、strict OpenSpec、文档；验证=bun run scripts/reelshort-localized-check.ts --verify --live-home <directory>。",
];
function render(done: boolean, evidence = "", live = "") {
  return "## 1. 本地化目录采样\n\n由 scripts/reelshort-localized-check.ts 生成。单 writer 串行交付，真实采样与隔离回归分别记录。\n\n" +
    tasks.map(t => `- [${done ? "x" : " "}] ${t}`).join("\n") + "\n\n## 2. 验证依据\n\n" +
    (done ? `完整软件验证证据：${evidence}。真实 CLI 目录回执：${live}。仅验证一次公开目录链路，不代表持续来源资格、市场热度或受众验证。\n` : "尚未完成最终验证。\n");
}
if (!existsSync(join(directory, ".openspec.yaml"))) throw new Error("Active OpenSpec change is required; archives are not modified.");
if (args.length === 1 && args[0] === "--init") {
  writeFileSync(tasksPath, render(false), { flag: "wx" });
} else if (args.length === 3 && args[0] === "--verify" && args[1] === "--live-home") {
  const home = resolve(root, args[2]!);
  if (!home.startsWith(resolve(root, "temp") + "/")) throw new Error("Use a local temp research home.");
  const envelopes = readdirSync(home).filter(f => /^\d+.*\.json$/.test(f)).map(f => JSON.parse(readFileSync(join(home, f), "utf8")));
  if (!envelopes.every(e => validateEnvelope(e).ok && e.status !== "failed")) throw new Error("Invalid or failed live CLI receipt.");
  for (const source of ["reelshort-ja", "reelshort-ko"]) {
    if (!envelopes.some(e => e.command === "radar.market.observe" && e.data.source_ref === source && e.data.origin === "live" &&
      e.data.items > 0 && e.data.readiness_unchanged === "planned")) throw new Error("Both explicit live samples are required.");
  }
  const build = envelopes.find(e => e.command === "radar.market.brief.build"), show = envelopes.find(e => e.command === "radar.market.brief.show");
  if (!build?.data.brief_ref || build.data.brief_ref !== show?.data.brief_ref) throw new Error("A matching brief readback is required.");
  if (!existsSync(tasksPath)) throw new Error("Initialize tasks first.");
  writeFileSync(tasksPath, render(false));
  const types = spawnSync(process.execPath, ["run", "typecheck"], { cwd: root, stdio: "inherit" });
  if (types.status !== 0) process.exit(types.status ?? 1);
  const suite = runWithEvidence({ command: process.execPath, args: ["run", "scripts/test-local-pg.ts", "--execute", "--all"], cwd: root });
  process.stdout.write(suite.stdout); process.stderr.write(suite.stderr);
  const evidence = relative(root, suite.directory);
  process.stderr.write(`[evidence] ${evidence}\n`);
  if (suite.exitCode !== 0) process.exit(suite.exitCode);
  const spec = spawnSync("openspec", ["validate", change, "--strict", "--no-interactive"], { cwd: root, stdio: "inherit" });
  if (spec.status !== 0) process.exit(spec.status ?? 1);
  writeFileSync(tasksPath, render(true, evidence, relative(root, home)));
} else { process.stderr.write("Usage: bun run scripts/reelshort-localized-check.ts --init | --verify --live-home <directory>\n"); process.exit(2); }
