## 1. 本地决策实验切片

由 scripts/decision-pilot-check.ts 生成。单 writer、无并行 Agent；服务、迁移与 CLI 共享状态，按依赖串行推进。

- [x] 1.1 决策包、证据、候选和显式基线：owner=radar；scope=decision 服务与新增表；依赖=无；验收=历史不变、幂等重放、陈旧写拒绝；失败复查=事务和修订；验证=bun run scripts/integration-test-run.ts -- bun test test/integration/decision-pilot.test.ts。
- [x] 1.2 实验锁定、结果修订、两轮暂停与恢复：owner=radar；scope=decision 规则；依赖=1.1；验收=基线顺序、时间、分母、来源类型和协议隔离；失败复查=冻结输入与结果修订；验证=bun test test/unit/decision-rules.test.ts。
- [x] 1.3 CLI 与输出：owner=radar；scope=decision CLI 及唯一调度入口；依赖=1.2；验收=完整进程闭环、五种输出、秘密拒绝和失败零写入；失败复查=参数校验及 envelope；验证=bun run scripts/integration-test-run.ts -- bun test test/integration/decision-pilot.test.ts。
- [x] 1.4 文档与兼容：owner=radar；scope=本地操作指南、研究状态、OpenSpec；依赖=1.3；验收=真实命令、旧合同不改、迁移保留旧数据；失败复查=文档链接、旧表和参数解析；验证=bun run typecheck、完整 bun test、openspec validate。

## 2. 验证

类型检查、完整测试和 OpenSpec strict 验证通过。完整测试证据：temp/integration-test-runs/2026-09-16T12-09-08-416Z-vqp6tb。运行中跳过的环境依赖测试以该目录日志为准，不把跳过记为通过。真实受众与发布未执行。
