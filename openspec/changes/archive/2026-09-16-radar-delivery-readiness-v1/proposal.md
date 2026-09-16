## Why

Radar 已有决策闭环与工作包，但当前任务声明、测试运行和真实业务验证容易混淆；PG 集成此前因 Docker 缺失被跳过，实际上本机可运行一次性 PostgreSQL。需要可审查的后续 DAG 和一轮有真实数据库证据的软件收口。

## What Changes

- 提供研究、实验、来源资格、十四天观察、阶段验收与发布决定的依赖图和 Goal。
- 新增只读开发脚本，投影当前与归档 OpenSpec 的任务声明及指定测试证据；不创建任务状态服务。
- 新增本机一次性 PostgreSQL 测试入口，复用既有测试/证据 runner，不使用配置中的真实目标。
- 补齐 PostgreSQL URI 的证据/回显脱敏，校正研究文稿与实际材料时长门的差异。
- 对已全部完成的软件变更复核并通过 OpenSpec CLI 归档；保留尚未完成的来源/live/canary 任务。

## Capabilities

### New Capabilities

- `radar-delivery-readiness`: 任务声明与验证证据分离、一次性真实 PG 验证和后续依赖计划。

### Modified Capabilities

无。没有改变 Radar 的领域状态、旧命令、数据迁移或 used 的语义。

## Impact

fit：Radar 本地开发脚本与产品交付文档。split-owner：Auctra 内容、Scaena 制作、DSH 交互、人工受众执行。不扩展为通用 DAG 平台或任务服务。新增脚本输出复用现有标准 envelope；新字段增量，无删除/迁移/弃用门。未执行发布、支付、招募或外部消息。
