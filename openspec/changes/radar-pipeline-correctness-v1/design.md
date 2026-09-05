# Design

## 权威序（B1/B6）

`LAYER_AUTHORITY = {1:3, 2:2, 3:1, 0:0}`。spec 场景钉死 L1>L0；L2 受控浏览器优于 L0 公共页爬取；L3 人工兜底最低但显式。不能用 layer 数字序（那会让空 metrics 的 L2 盖过 L1）。run 内 dedupe 与跨 run upsert 共用该序；`daily_items.source_layer` 记录 metrics 归属层，degraded 按归属层重算而非跟随最后写者；身份字段（title/url）胜者优先、败者补空，对称适用。

## 增量生产（B3）

upsert 再观测时对同名绝对 key 做差（read-before-write，不建前值表、不依赖同日两趟 schedule 耦合），写 `*_delta` + `delta_window_hours`；每次观测的 delta 只描述自己的窗口（写入前清除上一观测的 delta key）。消费端（spreadValue）任一 delta 存在即全用 delta 基准、缺失项计 0——混合 delta 与绝对总量会叠加不一致量纲。

## F6 分母排除当日

topic 频率统计排除当日行（`date < today`），当日行打 tag 与否不再影响分母 → 同日重跑分数确定。untagged 基线从 1 改 0（旧值让全新 topic 白拿 100 分）。多 topic 内容取其 topic 计数最大值。

## B5 双回执

dailyRun 在 collect 后立即记录 kind="collect" 回执（degradedLayers 完整），读者（card.ts/health.ts）零改动。kind 词表：collect | score | card | cluster | import | daily（daily 汇总回执保留）。

## 显式决策

- B4 导入用零依赖手写 RFC4180 最小子集（UTF-8 容 BOM、引号转义）；坏行报行号+原因不静默丢；confidence 固定 50（人工来源上限）；无 metrics 行 degraded
- F4 复用已定义但从未被调用的 EventWriter.error()
- F7 busy_timeout=5000 与 WAL 并列于 openDb；systemd 三 service 加 After/Wants 链 + ExecStart 包 flock -n（多 timer 恢复后并发写保护）
