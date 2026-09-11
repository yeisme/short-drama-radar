## ADDED Requirements

### Requirement: 阅读状态必须来自显式用户动作
系统 MUST 按 reader_ref/signal_ref/revision 记录显式已读；资源读取、页面打开、Agent 总结和停留时间 MUST NOT 自动标记已读。首版使用单一本地 reader，状态不写入创作反馈。

#### Scenario: Agent 预读
- **WHEN** Agent 为生成摘要读取十条证据
- **THEN** 用户未读列表不变化

#### Scenario: 标记本期已读
- **WHEN** 用户确认当前屏幕显示的五条信号
- **THEN** 只标记这五条的当前 revision，分页未显示、禁区过滤及随后新修订保持未读

### Requirement: 补看必须按信号修订去重并保留边界
补看 SHALL 返回未读修订，默认 30 天、分页 20 条；过久历史提供入口并说明边界，更正必须重新进入未读。

#### Scenario: 三天未使用
- **WHEN** 用户返回而旧信号没有任何新修订
- **THEN** 只突出新增/改变的信号，不按每天重复展示相同旧闻

#### Scenario: 已读信号被更正
- **WHEN** 已读 revision 1 后生成 correction revision 2
- **THEN** revision 2 仍未读，并能查看旧判断

### Requirement: 阅读和关注写入必须可恢复
每次 mutation MUST 携带幂等键和 reader revision，保存 payload digest 与 receipt；同键异参拒绝，陈旧状态冲突返回 state_conflict，结果未知先按键对账。

#### Scenario: 两入口并发修改
- **WHEN** Agent 与 DSH 基于同一 reader revision 分别标记已读和撤销已读
- **THEN** 只提交先到的一次，后一次返回冲突并重读，不静默覆盖

#### Scenario: 回执丢失
- **WHEN** mutation 已提交但客户端断线
- **THEN** 客户端可按原幂等键读取回执，不新建重复动作

### Requirement: 观察清单必须独立于创作偏好
系统 SHALL 支持 topic/work/platform/market 的观察清单及 active/paused/removed 状态。关注不得改变市场事实或写 saved/used/dismissed；暂停/取消不删除历史。

#### Scenario: 暂停后恢复
- **WHEN** 用户恢复一个暂停三天的关注项
- **THEN** 可查看暂停期间已有记录的变化，未采集的区间标 source_gap，不假装完整

### Requirement: 明确内容禁区必须覆盖所有读取出口
系统 MUST 使用 reader 禁区与 active Profile blocked_topics 的并集生成 policy_revision，应用于简报、搜索、详情、历史、对照及问答。普通创作偏好和 personal_fit MUST NOT 隐藏市场变化。

#### Scenario: 深链访问禁区内容
- **WHEN** 用户通过旧 evidence ref 或 Agent 问答请求当前被禁止的内容
- **THEN** 返回 content_blocked 安全说明，不泄露正文或在错误中复述内容

#### Scenario: Profile 切换
- **WHEN** active Profile 的禁区发生变化
- **THEN** 旧读取投影失效并由 owner 重算安全视图，客户端不能继续展示旧缓存正文
