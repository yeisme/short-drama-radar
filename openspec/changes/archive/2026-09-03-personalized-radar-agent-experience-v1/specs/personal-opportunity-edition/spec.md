## ADDED Requirements

### Requirement: 系统必须从原始条目构建稳定机会簇
系统 SHALL 使用版本化 builder 将同日 `daily_items` 按规范化 topic、hook family 与 format 聚合为 `radar.opportunity.v1`。每个机会 MUST 保存稳定 ref、cluster key、builder version、source item refs、evidence digest、market score、evidence confidence 与 degraded 状态。

#### Scenario: 多平台条目形成一个机会
- **WHEN** 抖音和小红书条目具有相同规范化 topic、hook family 与 format
- **THEN** builder 生成一个机会并保留两组 source refs，reason codes 可标记 `cross_platform_signal`

#### Scenario: 数据缺少平台指标
- **WHEN** 小红书条目没有公开播放量
- **THEN** 系统只使用已声明的互动代理指标和 confidence，不伪造播放量或跨平台等价指标

### Requirement: 市场、个人与证据分数必须独立公开
`radar.personal_opportunity.v1` MUST 分别返回 `market_score`、`personal_fit` 和 `evidence_confidence`，并 SHALL 返回 profile revision、ranker version、reason codes 与 evidence refs。内部 rank score MUST NOT 作为混淆三者语义的公开总分。

#### Scenario: 市场热但个人不适配
- **WHEN** 某机会 market score 很高但与当前 Profile 的题材、预算和资产不匹配
- **THEN** 系统保留高 market score 与低 personal fit，并用稳定 reason/risk code 解释排序位置

#### Scenario: 个人适配但证据不足
- **WHEN** 某机会与 Profile 高度匹配但来源 degraded 或 confidence 低
- **THEN** 系统保留高 personal fit 与低 evidence confidence，并显式标记需补证据

### Requirement: 个人排序必须确定、版本化且先执行硬过滤
系统 MUST 在排序前应用 blocked topics，随后使用冻结的 profile revision、feedback ledger snapshot、builder version 与 ranker version 计算 personal fit 和排序。相同输入 MUST 产生相同顺序；并列 MUST 使用稳定 tie-break。

#### Scenario: 相同输入重复构建
- **WHEN** 使用相同 date、source digest、profile revision、feedback snapshot 和 ranker version 重建 Edition
- **THEN** 系统产生相同机会顺序、分数、reason codes 和内容 digest

#### Scenario: 不同 Profile 排序不同
- **WHEN** Profile A 偏好低成本甜宠而 Profile B 偏好高概念悬疑
- **THEN** 同一机会集合可产生可解释的不同顺序，且每项 reason codes 引用各自 Profile revision

### Requirement: Morning Edition 必须不可变并允许空榜
系统 SHALL 生成 `radar.morning_edition.v1`，固定绑定 date、profile ref/revision、builder/ranker version、run/source refs、entries、status、known limitations 与 next actions。Edition 创建后 MUST 不被 Profile 更新、反馈或重跑覆盖。

#### Scenario: 生成高精度个人版次
- **WHEN** 有不超过 limit 且满足 minimum fit/confidence 的机会
- **THEN** 系统按稳定顺序创建 `ready` Edition，并为每项保存当时的个人投影快照

#### Scenario: 没有合格机会
- **WHEN** 所有机会被阈值、blocked topics 或重复抑制排除
- **THEN** 系统创建 `empty` Edition，entries 为空，并给出可区分的原因与 next action

#### Scenario: 后续反馈不改历史
- **WHEN** 用户在 Edition 生成后对其中机会提交 `dismissed`
- **THEN** 原 Edition 内容和 digest 不变，反馈只影响后续新 Edition

### Requirement: 降级与 stale 状态必须在 Edition 中显式传播
如果 source status degraded、数据 freshness 超限、证据低置信或 pipeline 部分失败，Edition MUST 标为 `degraded` 或拒绝生成，并 SHALL 保存 known limitations；系统 MUST NOT 用旧数据静默冒充当天成功。

#### Scenario: 当天采集失败但存在昨日数据
- **WHEN** 用户构建当天 Edition 且只有昨日成功快照
- **THEN** 系统不把昨日数据标为当天 ready，可返回 stale blocker 或用户显式选择的带日期历史 Edition

#### Scenario: 部分来源降级仍有合格证据
- **WHEN** 一个平台 degraded 但另一平台有满足阈值的证据
- **THEN** 系统可生成 degraded Edition，并在每个受影响条目和版次级别显示限制

### Requirement: 旧卡片合同必须保持兼容
本变更 MUST 保持 `short-drama-radar.card.v1` 的字段、枚举和 golden fixture 不变。个人 Edition SHALL 作为 additive 输出存在，不得把 Profile 字段或个人分数塞入旧卡片合同。

#### Scenario: 同一日同时生成 Card 与 Edition
- **WHEN** `radar run` 完成基础评分与个人排序
- **THEN** 系统可同时生成原 `card.v1` 和新的 Morning Edition，且 `card.v1` golden 测试字节语义不变

#### Scenario: 回滚个人化功能
- **WHEN** 运行旧 binary 读取包含新增个人化表的数据库
- **THEN** 旧 card 流程仍可使用既有表工作，新增表被安全忽略
