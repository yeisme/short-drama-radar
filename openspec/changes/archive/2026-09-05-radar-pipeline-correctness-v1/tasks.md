# Tasks

- [x] 1.1 B1 跨层去重改权威序 + 字段级 merge + `source_layer` 列 + L0/L1 重叠回归测试
- [x] 1.2 B6 upsert 按归属层重算 degraded、无变化不写、身份字段对称 gap-fill + 测试
- [x] 1.3 B5 `radar run` 补记 collect 回执 + CLI 级测试
- [x] 1.4 B2 spread 读 `comment_count`（黄金测试 1540→1628）+ B3 增量生产/消费 + 量纲统一 + 测试
- [x] 1.5 金样 digest 重录（结构断言不变）
- [x] 2.1 B4 `radar import --csv` 最小导入（RFC4180 子集、坏行显式、merge 复用、kind="import" 回执）+ 测试
- [x] 2.2 F4 --events 失败末行 error 事件 + 集成测试；同步 mcp-cli-interaction.md §3.3/3.4 事件字段文档
- [x] 3.1 F5 edition sourceRunRefs 有序当日过滤 + cli runs 列表排序
- [x] 3.2 F6 频率分母排除当日 + 多 topic + untagged=0 + 同日双跑确定性测试
- [x] 3.3 F8 persistOpportunities 事务 + 回滚测试
- [x] 3.4 F10 episode min/max 合并当前值 + 测试
- [x] 3.5 F7 busy_timeout + timer After/Wants + flock
- [x] 3.6 B7 L2 风控检测收窄 + fixture 单测
- [x] 4.1 P3：runs.id opaque + recordRun 合并 + --limit 校验 + publishedAt ISO + isStableId 锚定
- [x] 4.2 P3：审计 failed≠denied + audit() 移出 try + loadConfig/openDb 入 try + schedule 转义 + config 校验
- [x] 4.3 P3：死代码清理（fetchDetail/signUrl/adapterContext）
- [x] 5.1 specs delta（radar-pipeline + radar-cli-agent-contract）+ strict validate + 全量验证
