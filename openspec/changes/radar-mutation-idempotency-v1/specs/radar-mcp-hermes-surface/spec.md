## ADDED Requirements

### Requirement: MCP 可见 mutation 必须幂等且复用可审计

MCP 可见的本地写 action（`score`、`cluster_build`、`edition_build`）SHALL 具有自然键身份：相同输入的重复调用返回既有结果与回执，MUST NOT 追加重复数据行。审计账本 SHALL 在条目命中自然键复用时携带 `idempotent_reuse: true`；`denied` outcome MUST 只用于 lane/权限拒绝，运行失败使用 `error`。

#### Scenario: operator 重复构建 Edition
- **WHEN** operator 连续两次 `radar.execute action=edition_build` 且输入不变
- **THEN** 两次返回同一 editionRef，第二次审计条目带 `idempotent_reuse: true`，morning_editions 不新增行

#### Scenario: 同日重复 score
- **WHEN** 同一数据同日重复执行 `score`
- **THEN** runs 表只保留一个该结果指纹的 score 回执
