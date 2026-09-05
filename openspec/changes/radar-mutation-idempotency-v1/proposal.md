# Radar 可见 mutation 幂等

## Why

radar-mcp-external-action-gate-v1 的提案要求"可见 mutation 要求 idempotency 与持久审计"，但实现未完成：`edition_build` 的 editionRef 哈希含毫秒时间戳且无自然键约束，每次调用（MCP 或 CLI）都追加整套全新 edition 行 + entries；`score` 每次产生新 run 行；`cluster_build` 同日重建也每次新行。重复调用会堆积重复数据并让审计账本无法区分"新 mutation"与"重放"。

## What Changes

- **edition 幂等**：editionRef 改为对输入指纹（ranked 元组 + limit；反馈调整体现在 personalFit 中，无 revision 变化也能改变指纹）+ profile ref/revision 的确定性哈希。同指纹重建返回现有不可变 Edition（`reused=true`），不追加行。复用已有 `edition_ref` UNIQUE 索引作为自然键——零新 DDL、零迁移
- **score 幂等**：run id 改为 `score-<date>-<结果指纹>`（同日重打分在 F6 确定性下结果相同→同指纹→复用一个回执）
- **cluster_build 幂等**：run id 改为 `cluster-<date>-<结果指纹>`
- **审计**：`radar.mcp.audit.v1` 条目新增可选 `idempotent_reuse` 布尔——自然键命中返回既有回执时为 true；"denied" 继续只表示 lane/权限拒绝

## Impact

Edition 身份语义从"每次生成一个"变为"同输入同一身份"（append-only 历史保留：输入变化→新行）；editionBuildAction facts 新增 `idempotent_reuse`；无 schema 变化、无合同字段移除；历史时间戳 ref 的存量行不受影响（新 ref 空间不冲突）。

## Deferred

- `feedback_add`/`opportunity_review` 已有幂等键（radar.mcp.handoff.v1），本 change 不动
