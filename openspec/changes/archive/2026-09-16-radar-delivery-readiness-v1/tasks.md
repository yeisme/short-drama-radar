## 1. 本地决策实验切片

由 scripts/decision-pilot-check.ts 生成。单 writer、无并行 Agent；服务、迁移与 CLI 共享状态，按依赖串行推进。

- [x] 1.1 完成后续 DAG 与 Goal；owner=radar；scope=delivery-dag.md；依赖=任务清点；验收=来源/软件/业务/发布门独立、全部能力保留；验证=人工对照现有 OpenSpec 与用户计划。
- [x] 1.2 只读任务与证据投影；owner=radar；scope=delivery-status.ts 与测试；依赖=1.1；验收=不把声明判完成、路径拒绝、标准输出；验证=delivery-status 单元及集成测试。
- [x] 1.3 一次性 PG 与脱敏；owner=radar；scope=test-local-pg.ts、证据 runner 和 PG 基座；依赖=无；验收=真实同步故障回放、不用配置目标、退出清理和输出脱敏；验证=bun run scripts/test-local-pg.ts。
- [x] 1.4 本地最终门；owner=radar；scope=文档、类型、全量测试与 strict spec；依赖=1.2、1.3；验收=完整测试含真实 PG、旧合同不回归；验证=bun run scripts/decision-pilot-check.ts --verify --delivery。

## 2. 验证

类型检查、完整测试和 OpenSpec strict 验证通过。完整测试证据：temp/integration-test-runs/2026-09-16T12-47-59-800Z-ahlyvz。运行中跳过的环境依赖测试以该目录日志为准，不把跳过记为通过。真实受众与发布未执行。
