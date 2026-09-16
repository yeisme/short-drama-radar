## Why

市场 pipeline 已能采集观测并逐条目刷新作品映射，但所有作品停在 `mapping_status=candidate`：2026-09-16 红果 live 采样 24 部作品全部 candidate、`canonical_work_ref=null`。`radar market work review` 命令虽已存在，却没有运营化的「正式入库门」：candidate → canonical 没有审核节奏、没有批量操作、拒绝不落原因、观测解析质量（`field_coverage`、`skipped_links`）只在回执里一闪而过，无法量化回归。

## What Changes

- 定义版本化入库门规则集（拟命名 `work-ingestion-gate-rules.v1`）：跨批次身份印证、别名归并完成、必需字段覆盖达标、非 fixture 证据下限；评估只读，判定结果落为不可变 gate decision，拒绝原因显式可查。
- 新增批量 review：按来源/批次筛选 candidate，一次事务记录全部决定并返回幂等回执；新增门控 promote，未通过门的晋级具名拒绝，owner 显式 override 必须留原因。
- 观测质量闭环：observe/import 在写入观测的同一事务持久化 `field_coverage` 与 skipped 归因；`radar health` 增加市场观测质量段，可跨窗口量化回归；未来 `radar market canary report` 实现时必须消费这些记录。
- 诚实边界：入库门不改变来源 readiness，不自动晋级；canonical 化必须产生新 mapping revision 并引用已存证据，不回写不可变观测；fixture 证据不计入真实验证。
- 与并行变更 `radar-hongguo-catalog-parsing-v1` 的关系：字段覆盖门槛引用其清洗后的解析质量；本变更 spec 不阻塞撰写，实现上把该依赖标为 Lane A 完成后的 lane。

## Capabilities

### New Capabilities

- `radar-work-ingestion-gate`：版本化入库门规则、只读评估、不可变 gate decision 与拒绝原因登记。
- `radar-work-review-batches`：按来源/批次筛选的批量 review、门控 promote 与幂等回执。
- `radar-observation-quality-metrics`：观测质量记录持久化、health 质量段与回归量化。

### Modified Capabilities

- `radar-hongguo-live-observe`：live observe 回执中的 `field_coverage` 与 skipped 归因从一次性返回值升级为同事务持久化的质量记录；observe 的资格门、来源范围与失败语义不变。

## Impact

范围为 `src/market/`（gate、batch review、quality）、`src/db/`（三张新表与集中 DDL）、`src/pipeline/health.ts`、CLI、测试与产品/接口文档，代码仍为 TypeScript/Bun＋Drizzle。不新增服务端、不开放 MCP 写入、不改变旧 `work review` 底层身份审阅合同与既有简报语义。

本 change 目前只有规格文档；所有实现任务均未完成。
