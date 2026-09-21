# Proposal

## Why

真实业务验收需要 owner 生成案例、保留原流程并存储人工反馈；源码任务完成不代表正式接入或效果通过。

## What Changes

新增可选 owner-bound 验收入口，读取既有 CLI/app projection；QA 状态在用户级本 owner 存储，业务正文/排名/审批不变。共享 QA 机械逻辑由 Aigora 工具维护，领域采样和问题由本 owner 维护。缺失数据或读取不兼容时产生 typed gap，不编造案例。

## Capabilities

### New Capabilities

- `radar-real-judgment-acceptance`：真实案例与可持久化复核。

### Modified Capabilities

无；原命令/领域记录不变。

## Impact

仅可选 scripts 验收面，不替换主产品 CLI；执行通过公共 Go SDK/正式 adapter，feedback 不等于 adoption。
