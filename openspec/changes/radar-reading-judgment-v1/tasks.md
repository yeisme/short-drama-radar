# 实施与验收任务

由 scripts/openspec-tasks.py 维护状态。

- [x] 1.1 owner=Radar；scope=领域最小投影与问题集；depends=公共 SDK 合同；lane=domain；实现 source/candidate/question/policy 版本绑定和确定性前置规则；验收=覆盖 design 场景且不夹带未授权文本；验证=bun test --timeout 30000（先限本 slice）；失败先修 projection fixture。 | evidence: bun test test/unit/reading-judgment-projection.test.ts --timeout 30000 -> 6 pass/0 fail (morning-relevance/cross-market/false-negative-retention/无未授权文本)；bun test --timeout 30000 -> 387 pass/0 fail；bun run typecheck 通过
- [x] 1.2 owner=Radar；scope=可选 SDK consumer；depends=1.1,SDK 包；lane=integration；实现 off/shadow/assist 和注入 transport，默认 off；验收=off/replay 零调用且 unknown outcome 不自动重发；验证=bun test --timeout 30000；失败复验提交状态与授权。 | evidence: bun test test/unit/reading-judgment-consumer.test.ts --timeout 30000 -> 10 pass/0 fail（off 零调用零写入、replay 零调用、unknown outcome 不自动重发 fresh 才新 attempt、capability 预检零 evaluate）；bun test --timeout 30000 -> 397 pass/0 fail；SDK 包尚不存在，按冻结合同实现自有 domain seam+fixture transport（schema 1.0/snake_case/DescribeCapabilities/Evaluate/错误码集/三 primitive）
- [ ] 1.3 owner=Radar；scope=领域建议/evidence 与原 review handoff；depends=1.2；lane=domain；复用既有应用服务生成证据，保持旧 envelope 和 canonical 权限；验收=stale/权限撤销不能采纳且不隐式业务执行；验证=bun test --timeout 30000；失败仅回修 owner 投影。
- [ ] 1.4 owner=Radar；scope=场景矩阵与边界测试；depends=1.3；lane=verification；复用现有 runner 包装 offline integration，覆盖全部场景与注入/脱敏；验收=非零测试且成功失败均有六类 evidence；验证=bun test --timeout 30000；失败保留证据并区分本变更与环境问题。
- [ ] 1.5 owner=Radar；scope=校准与渐进接入说明；depends=1.4；lane=handoff；固定 baseline/留出集/误报漏报度量及关闭恢复说明，不自动 live；验收=明确 exploratory，保留用户显式启用；验证=openspec validate radar-reading-judgment-v1 --strict --no-interactive；失败修 readiness 声明。
