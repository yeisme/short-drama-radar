# Radar 流水线正确性修复

## Why

三路代码审计（采集/流水线、MCP/CLI、就绪度）发现 2 个已运行时验证的 P1 数据错误与一批 P2 逻辑缺陷：跨层去重方向反了导致 L0 公共页数据覆盖 L1 签名 API 数据（爆款因 confidence 40 过不了 60 门进不了卡）；spread 评分读错 metrics key 导致评论互动全部漏计；"传播增速增量"从未实现（spec 强制）；`radar run` 的日子对 card/health 不可见降级信息；upsert 静默沿用旧 metrics 无行级语义；--events 失败路径静默违反合同；edition 血源随机；score 同日重跑漂移；opportunity 重建无事务；SQLite 并发无 busy_timeout。

## What Changes

- **B1** 跨层去重改为显式权威序（L1 签名 API > L2 受控浏览器 > L3 人工 > L0 公共页），败者字段补缺胜者；daily_items 增加 `source_layer` 列记录 metrics 归属层
- **B2** spread 读取规范化实际写入的 `comment_count`（修复 `comments_count` 拼写）
- **B3** collect 在再观测时计算 `*_delta` 增量与观测窗口；spread 任一 delta 存在即用增量基准（不与绝对总量混加）
- **B5** `radar run` 同时记录 kind="collect" 回执（card/health 读者只认 collect）
- **B6** upsert 重算 degraded（按归属层）、无实际变化不写不刷 updatedAt、身份字段对称 gap-fill
- **B4** Layer 3 最小人工导入：`radar import --csv <path>`
- **F4** --events 失败路径输出末行 error 事件（spec 已有要求，实现补课）
- **F5** edition sourceRunRefs 与 runs 列表改为有序受限查询
- **F6** topic 频率分母排除当日（同日重跑确定性）；多 topic 取最大计数；untagged 基线 0
- **F7** SQLite busy_timeout PRAGMA；systemd timer After/Wants 排序 + flock
- **F8** persistOpportunities 包事务
- **F10** profile set --episode-min/max 合并当前值
- **B7** L2 风控检测收窄到可见挑战元素/URL/标题
- **P3 批** runs.id opaque 化、recordRun 合并、--limit 数值校验、publishedAt ISO 化、isStableId 锚定、审计 failed≠denied、audit 移出 try、config/db 错误走输出合同、schedule 单元转义、死代码清理

## Impact

分数语义变化（B2/B3/F6）：重算值与历史值不同——pre-canary 无对外历史，可接受；`short-drama-radar.card.v1` 字段零改动（金样 digest 因评论互动计入而重录，结构断言不变）。新增 `daily_items.source_layer` 列（migrate 存在性保护）。

## Deferred

- feedback/edition hydrate N+1、health/canary 全表扫描（纯性能，另立 change）
- isNew 回看窗口扩宽（当前 spec 未定义多日窗口）
- L2 抽取 metrics 上限标注（归 layer2-browser-unlock change）
- mutation 幂等（归 radar-mutation-idempotency-v1）
