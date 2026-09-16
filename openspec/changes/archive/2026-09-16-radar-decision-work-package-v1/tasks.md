## 1. 本地决策实验切片

由 scripts/decision-pilot-check.ts 生成。单 writer、无并行 Agent；服务、迁移与 CLI 共享状态，按依赖串行推进。

- [x] 1.1 取消与审计：owner=radar；scope=decision 服务和迁移；依赖=无；验收=互斥、幂等、失败序列保留；验证=decision-work-package 集成测试。
- [x] 1.2 材料绑定与协议条件：owner=radar；scope=样本、冻结、结果入口；依赖=1.1；验收=实际哈希、配对、摘要拒绝和旧合同兼容；验证=decision-work-package 集成测试。
- [x] 1.3 准备投影与本地导出：owner=radar；scope=CLI、工作包；依赖=1.2；验收=缺口不评分、禁止覆盖、真实命令闭环；验证=decision-work-package 集成测试。
- [x] 1.4 收口：owner=radar；scope=文档与兼容性；依赖=1.3；验收=typecheck、全量测试、strict OpenSpec；失败复查=证据目录及引入变更。

## 2. 验证

类型检查、完整测试和 OpenSpec strict 验证通过。完整测试证据：temp/integration-test-runs/2026-09-16T12-32-28-402Z-hhrxcd。运行中跳过的环境依赖测试以该目录日志为准，不把跳过记为通过。真实受众与发布未执行。
