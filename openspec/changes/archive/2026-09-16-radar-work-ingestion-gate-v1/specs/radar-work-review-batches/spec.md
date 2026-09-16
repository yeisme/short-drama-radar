## ADDED Requirements

### Requirement: 批量 review 必须支持按来源与批次筛选
系统 MUST 提供批量审核动作，对指定来源（可选叠加观测批次）范围内当前 head 为 candidate 的作品映射逐条记录 gate decision。范围内全部决定 MUST 在一次事务中提交；任何单条失败 MUST 整批回滚，不产生部分审核结果。

#### Scenario: 按来源审核
- **WHEN** owner 对 hongguo 来源执行批量 review
- **THEN** 该来源全部 candidate 各得一条新决定，其他来源映射不受影响

#### Scenario: 合法空范围
- **WHEN** 指定来源当前没有 candidate 作品
- **THEN** 返回 evaluated=0 的合法回执，不报错也不伪造成处理出结果

#### Scenario: 未注册来源
- **WHEN** 对未注册来源执行批量 review
- **THEN** 返回具名 `source_not_found`，零写入

### Requirement: 批量操作必须幂等且有可查询回执
批量 review MUST 要求显式幂等键并返回 `radar.work_review_batch_receipt.v1` 回执，含 scope、evaluated/promotable/rejected 计数、原因码分布与全部 decision_refs。同键同参重放 MUST 返回原回执且零新决定；同键异参 MUST 拒绝 `idempotency_conflict`。断线结果未知时 MUST 先按键对账，未查清不得重放写入。

#### Scenario: 断线后重放同一请求
- **WHEN** 同一幂等键与相同参数被再次提交
- **THEN** 返回原回执，决定计数与 decision_refs 不变

#### Scenario: 同键不同筛选范围
- **WHEN** 同一幂等键携带不同来源或批次参数
- **THEN** 拒绝并保留原回执

### Requirement: 晋级必须通过入库门
逐作品 promote MUST 要求该作品在现行 gate_version 下、针对当前 head revision 的最新决定为 promotable；无决定、决定为 rejected 或决定针对陈旧 revision MUST 分别具名拒绝（如 `gate_not_passed`、`stale_gate_decision`）。owner 显式 override MUST 提供原因文本，并在同一事务记录一条带 override 标记的可审计决定；override 不改变规则本身。

#### Scenario: 未通过门的晋级
- **WHEN** 对最新决定为 rejected 的作品执行 promote
- **THEN** 拒绝并返回当前原因码与 gate report 入口，映射零变更

#### Scenario: 显式 override
- **WHEN** owner 携带原因文本 override 晋级
- **THEN** 晋级生效且同事务留下 overridden 决定，原因可查询

### Requirement: 所有审核 mutation 必须走 CLI 或 application service
Gate decision、review 回执与映射写入 MUST 只经 Radar CLI/application service 产生；禁止手工改库、禁止手写 JSON/YAML 审核资产。既有 `radar market work list/show/review` 命令与 flag 惯例 MUST 保持不变。

#### Scenario: 单作品既有审阅入口
- **WHEN** owner 使用既有 `work review` 命令
- **THEN** 其 flag、revision 与幂等语义与本变更前一致
