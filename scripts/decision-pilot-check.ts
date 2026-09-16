#!/usr/bin/env bun
// Own the generated OpenSpec task state; no hand-authored completion metadata.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { runWithEvidence } from "./integration-test-run.ts";

const root = join(import.meta.dir, "..");
const delivery = process.argv.includes("--delivery");
const workPackage = process.argv.includes("--work-package");
const change = delivery ? "radar-delivery-readiness-v1" : workPackage ? "radar-decision-work-package-v1" : "radar-decision-pilot-cli-v1";
const directory = join(root, "openspec/changes", change);
const tasksPath = join(directory, "tasks.md");
const tasks = delivery ? [
  "1.1 完成后续 DAG 与 Goal；owner=radar；scope=delivery-dag.md；依赖=任务清点；验收=来源/软件/业务/发布门独立、全部能力保留；验证=人工对照现有 OpenSpec 与用户计划。",
  "1.2 只读任务与证据投影；owner=radar；scope=delivery-status.ts 与测试；依赖=1.1；验收=不把声明判完成、路径拒绝、标准输出；验证=delivery-status 单元及集成测试。",
  "1.3 一次性 PG 与脱敏；owner=radar；scope=test-local-pg.ts、证据 runner 和 PG 基座；依赖=无；验收=真实同步故障回放、不用配置目标、退出清理和输出脱敏；验证=bun run scripts/test-local-pg.ts。",
  "1.4 本地最终门；owner=radar；scope=文档、类型、全量测试与 strict spec；依赖=1.2、1.3；验收=完整测试含真实 PG、旧合同不回归；验证=bun run scripts/decision-pilot-check.ts --verify --delivery。",
] : workPackage ? [
  "1.1 取消与审计：owner=radar；scope=decision 服务和迁移；依赖=无；验收=互斥、幂等、失败序列保留；验证=decision-work-package 集成测试。",
  "1.2 材料绑定与协议条件：owner=radar；scope=样本、冻结、结果入口；依赖=1.1；验收=实际哈希、配对、摘要拒绝和旧合同兼容；验证=decision-work-package 集成测试。",
  "1.3 准备投影与本地导出：owner=radar；scope=CLI、工作包；依赖=1.2；验收=缺口不评分、禁止覆盖、真实命令闭环；验证=decision-work-package 集成测试。",
  "1.4 收口：owner=radar；scope=文档与兼容性；依赖=1.3；验收=typecheck、全量测试、strict OpenSpec；失败复查=证据目录及引入变更。",
] : [
  "1.1 决策包、证据、候选和显式基线：owner=radar；scope=decision 服务与新增表；依赖=无；验收=历史不变、幂等重放、陈旧写拒绝；失败复查=事务和修订；验证=bun run scripts/integration-test-run.ts -- bun test test/integration/decision-pilot.test.ts。",
  "1.2 实验锁定、结果修订、两轮暂停与恢复：owner=radar；scope=decision 规则；依赖=1.1；验收=基线顺序、时间、分母、来源类型和协议隔离；失败复查=冻结输入与结果修订；验证=bun test test/unit/decision-rules.test.ts。",
  "1.3 CLI 与输出：owner=radar；scope=decision CLI 及唯一调度入口；依赖=1.2；验收=完整进程闭环、五种输出、秘密拒绝和失败零写入；失败复查=参数校验及 envelope；验证=bun run scripts/integration-test-run.ts -- bun test test/integration/decision-pilot.test.ts。",
  "1.4 文档与兼容：owner=radar；scope=本地操作指南、研究状态、OpenSpec；依赖=1.3；验收=真实命令、旧合同不改、迁移保留旧数据；失败复查=文档链接、旧表和参数解析；验证=bun run typecheck、完整 bun test、openspec validate。",
];

function render(done: boolean, evidence?: string): string {
  return "## 1. 本地决策实验切片\n\n由 scripts/decision-pilot-check.ts 生成。单 writer、无并行 Agent；服务、迁移与 CLI 共享状态，按依赖串行推进。\n\n"
    + tasks.map(t => `- [${done ? "x" : " "}] ${t}`).join("\n")
    + "\n\n## 2. 验证\n\n"
    + (done ? `类型检查、完整测试和 OpenSpec strict 验证通过。完整测试证据：${evidence}。运行中跳过的环境依赖测试以该目录日志为准，不把跳过记为通过。真实受众与发布未执行。\n`
      : "尚未完成最终验证。聚焦集成测试须经已有 integration-test-run.ts 运行以保留证据。\n");
}

const args = process.argv.slice(2).filter(arg => !["--work-package", "--delivery"].includes(arg));
if ((delivery && workPackage) || args.length !== 1 || !["--init", "--verify"].includes(args[0]!)) {
  process.stderr.write("Usage: bun run scripts/decision-pilot-check.ts --init|--verify [--work-package|--delivery]\n");
  process.exit(2);
}
if (!existsSync(join(directory, ".openspec.yaml"))) {
  process.stderr.write("The active decision-pilot OpenSpec change is required. Archived changes are not modified.\n");
  process.exit(1);
}
if (args[0] === "--init") {
  writeFileSync(tasksPath, render(false), { flag: "wx" });
  process.stdout.write("Created the decision-pilot task skeleton.\n");
} else {
  if (!existsSync(tasksPath)) throw new Error("Initialize the task skeleton first.");
  writeFileSync(tasksPath, render(false));
  const typecheck = spawnSync(process.execPath, ["run", "typecheck"], { cwd: root, encoding: "utf8", stdio: "inherit" });
  if (typecheck.status !== 0) process.exit(typecheck.status ?? 1);
  const suite = runWithEvidence({ command: process.execPath, args: delivery ? ["run", "scripts/test-local-pg.ts", "--execute", "--all"] : ["test", "--timeout", "30000"], cwd: root });
  process.stdout.write(suite.stdout); process.stderr.write(suite.stderr);
  const evidence = relative(root, suite.directory);
  process.stderr.write(`[evidence] ${evidence}\n`);
  if (suite.exitCode !== 0) process.exit(suite.exitCode);
  for (const file of ["docs/product/greenlight-pilot/cli-guide.md", "proposal.md", "design.md"]) {
    const path = file.startsWith("docs/") ? join(root, file) : join(directory, file);
    if (!existsSync(path) || !readFileSync(path, "utf8").trim()) throw new Error("Required decision documentation is missing.");
  }
  const spec = spawnSync("openspec", ["validate", change, "--strict", "--no-interactive"], { cwd: root, stdio: "inherit" });
  if (spec.status !== 0) process.exit(spec.status ?? 1);
  writeFileSync(tasksPath, render(true, evidence));
  process.stdout.write("Decision-pilot verification completed; OpenSpec task state updated.\n");
}
