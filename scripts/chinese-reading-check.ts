#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runWithEvidence } from "./integration-test-run.ts";
const root = join(import.meta.dir, "..");
const change = "radar-chinese-reading-v1";
const directory = join(root, "openspec/changes", change);
const tasks = [
  "1.1 译文与原文绑定存储；owner=radar；scope=translation 服务及本地表；验收=幂等、修订、失效、简繁隔离、原文不变；验证=market-translation 集成测试。",
  "1.2 中文阅读 CLI；owner=radar；依赖=1.1；验收=原文回退、政策、输出模式、无模型网络调用；验证=market-translation 进程测试。",
  "1.3 使用文档与后续边界；owner=radar；依赖=1.2；验收=真实命令、未审核声明、不覆盖地区/题材/身份；验证=文档与 CLI 合同对照。",
  "1.4 软件收口；owner=radar；依赖=1.1–1.3；验收=类型、全量测试含真实 PG、strict OpenSpec；验证=bun run scripts/chinese-reading-check.ts --verify。",
];
function render(done: boolean, evidence = "") {
  return "## 1. 中文标题阅读层\n\n由 scripts/chinese-reading-check.ts 生成；单 writer，领域状态由 CLI／服务维护。\n\n" +
    tasks.map(t => `- [${done ? "x" : " "}] ${t}`).join("\n") + "\n\n## 2. 验证\n\n" +
    (done ? `类型、完整测试与 strict spec 通过。软件证据：${evidence}。真实样本译文演练单独记录于运行文档，不代表人工审核或市场验证。\n` : "待完成最终验证。\n");
}
const args = process.argv.slice(2), path = join(directory, "tasks.md");
if (!existsSync(join(directory, ".openspec.yaml"))) throw new Error("Active OpenSpec change required; archives are not changed.");
if (args.length === 1 && args[0] === "--init") writeFileSync(path, render(false), { flag: "wx" });
else if (args.length === 1 && args[0] === "--verify") {
  if (!existsSync(path)) throw new Error("Initialize tasks first.");
  writeFileSync(path, render(false));
  const types = spawnSync(process.execPath, ["run", "typecheck"], { cwd: root, stdio: "inherit" });
  if (types.status !== 0) process.exit(types.status ?? 1);
  const suite = runWithEvidence({ command: process.execPath, args: ["run", "scripts/test-local-pg.ts", "--execute", "--all"], cwd: root });
  process.stdout.write(suite.stdout); process.stderr.write(suite.stderr);
  process.stderr.write(`[evidence] ${suite.directory}\n`);
  if (suite.exitCode !== 0) process.exit(suite.exitCode);
  if (!readFileSync(join(root, "docs/runtime/chinese-reading.md"), "utf8").trim()) throw new Error("Reading guide required.");
  const spec = spawnSync("openspec", ["validate", change, "--strict", "--no-interactive"], { cwd: root, stdio: "inherit" });
  if (spec.status !== 0) process.exit(spec.status ?? 1);
  writeFileSync(path, render(true, `temp/integration-test-runs/${suite.runId}`));
} else { process.stderr.write("Usage: bun run scripts/chinese-reading-check.ts --init|--verify\n"); process.exit(2); }
