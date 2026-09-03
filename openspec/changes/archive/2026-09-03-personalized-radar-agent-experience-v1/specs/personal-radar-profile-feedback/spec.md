## ADDED Requirements

### Requirement: 系统必须使用统一的个人 Profile 合同
系统 MUST 以 `radar.personal_profile.v1` 表达所有个人偏好，并 SHALL 支持题材、主题、受众、平台、形式、钩子、情绪、预算、风险、blocked topics、可用资产标签、语言、单集时长和 Edition 阈值。系统 MUST NOT 为不同用户派生不同数据库 schema。

#### Scenario: 创建合法 Profile
- **WHEN** 用户运行 `radar profile create --name personal` 并提供合法维度
- **THEN** 系统创建一个符合公共 schema 的命名 Profile，返回稳定 profile ref 和 revision 1

#### Scenario: Profile 维度非法
- **WHEN** 用户提交越界风险值、反向时长范围或未知结构化字段
- **THEN** 系统 fail closed，返回字段路径和可运行的修复命令，且不写入部分 Profile

### Requirement: 本地数据库必须支持多个命名 Profile 和唯一 active profile
系统 SHALL 在同一本地数据库保存多个相互隔离的命名 Profile，但任一时刻 MUST 至多有一个 active profile。未显式传入 `profile_ref` 的个人化命令 MUST 使用 active profile；不存在 active profile 时 MUST 明确失败。

#### Scenario: 激活另一个 Profile
- **WHEN** 用户运行 `radar profile activate <profile-ref>`
- **THEN** 系统以单个原子事务切换 active profile，并使其他 Profile 保持未激活

#### Scenario: 未配置 active profile
- **WHEN** 用户运行 `radar edition build` 且没有 active profile 或显式 `--profile`
- **THEN** 系统返回 `profile_required`，不使用任意默认偏好生成 Edition

### Requirement: Profile 更新必须产生不可变 revision
每次成功的 `radar profile set` MUST 创建新的不可变 `personal_profile_revision`，记录 schema version、revision、digest 与时间；历史 revision MUST 可按 ref 读取且不得被后续更新覆盖。

#### Scenario: 修改偏好后生成新 revision
- **WHEN** 用户给现有 Profile 增加一个 topic 权重
- **THEN** 系统保留旧 revision，创建递增的新 revision，并将 Profile head 指向新 revision

#### Scenario: 历史 Edition 读取旧 Profile
- **WHEN** 当前 Profile 已更新而用户读取此前生成的 Edition
- **THEN** Edition 仍显示其绑定的旧 profile revision 与 reason codes，不使用当前 head 重新解释

### Requirement: 偏好反馈必须 append-only 且使用固定枚举
系统 MUST 以 `radar.preference_feedback.v1` append `saved|dismissed|used|not_relevant|too_risky|already_seen` 反馈，记录 profile ref、目标 ref、时间、idempotency key 和可选的不透明 project ref。既有反馈 MUST NOT 原地改写或删除；纠错 SHALL 通过补充事件表达。

#### Scenario: 添加保存反馈
- **WHEN** 用户对某机会提交 `saved` 且 idempotency key 未见过
- **THEN** 系统 append 一条反馈并返回 feedback ref，不修改机会证据或历史 Edition

#### Scenario: 重复提交相同反馈
- **WHEN** 客户端因重连再次提交相同 idempotency key
- **THEN** 系统返回原 feedback ref，且 ledger 中不出现第二条重复事件

### Requirement: 反馈影响必须有界且不能越过硬过滤
系统 SHALL 按 ranker version 将反馈映射为确定性 adjustment，并 MUST 将单个 Profile 的最终 feedback adjustment clamp 到 `[-15,+15]`。`blocked_topics` MUST 在反馈计算前硬过滤，任何正向反馈都不得恢复被阻断机会。

#### Scenario: 大量正向反馈达到上限
- **WHEN** 同类机会累积的正向反馈原始值超过 15
- **THEN** 该类机会的 feedback adjustment 固定为 15，且回放得到相同结果

#### Scenario: 已保存机会后来被加入 blocked topics
- **WHEN** 当前 Profile revision 将该机会主 topic 加入 blocked topics
- **THEN** 新 Edition 排除该机会，即使历史反馈为 `saved` 或 `used`

### Requirement: Profile 与反馈投影必须按 Profile 隔离并脱敏
系统 MUST 按 profile ref 隔离反馈和排序输入。MCP/client safe projection SHALL 只返回必要偏好摘要、revision 与 digest，不得返回凭据、自由备注、原始用户路径或其他 Profile 的反馈。

#### Scenario: 查询 Profile A 的安全摘要
- **WHEN** consumer 读取 active Profile A 的 safe projection
- **THEN** 返回 A 的可公开维度摘要和 revision，且不包含 Profile B 数据或本地 secret/config 内容

#### Scenario: 使用错误 Profile 引用写反馈
- **WHEN** 请求中的 opportunity projection 属于 Profile A，但反馈明确指定 Profile B 且没有有效重绑定
- **THEN** 系统拒绝写入并返回 `profile_scope_mismatch`
