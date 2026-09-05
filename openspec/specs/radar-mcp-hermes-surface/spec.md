# radar-mcp-hermes-surface Specification

## Purpose
TBD - created by archiving change personalized-radar-agent-experience-v1. Update Purpose after archive.
## Requirements
### Requirement: MCP 必须是共享应用层的紧凑投影
`radar mcp --transport stdio` MUST 与 CLI 调用同一 application service、Drizzle repositories 和领域合同。MCP SHALL 只暴露 `radar.search`、`radar.execute`、`radar://` resources 与 `radar_personal_brief`；MUST NOT 为 CLI leaf command 建立一一对应工具或 shell fallback。

#### Scenario: CLI 与 MCP 读取同一 Edition
- **WHEN** CLI 和 MCP 按同一 edition ref 读取结果
- **THEN** 两者返回相同 profile revision、ranker version、digest 和 degraded 语义

#### Scenario: 应用层 action 不可用
- **WHEN** MCP handler 找不到真实 backing action
- **THEN** capability 标为 unavailable/blocked，工具不得通过 shell 调用 CLI 冒充成功

### Requirement: MCP 必须执行 reader、curator、operator lane

MCP SHALL 默认 reader，并按 reader < curator < operator 累积授权。`radar.search` 对所有 lane 可用；`feedback_add/opportunity_review` 至少需要 curator；`score/cluster_build/edition_build` 需要 operator。具有外部采集副作用的动作（`collect`、`daily_run`）MUST NOT 经任何 MCP lane 暴露于 discovery 或 dispatch，其唯一执行入口是 CLI 与 owner scheduler。Profile create/set/activate MUST NOT 经任何 MCP lane 暴露。

#### Scenario: reader 尝试写反馈
- **WHEN** reader lane 调用 `radar.execute action=feedback_add`
- **THEN** 系统以与未知 action 等价的安全错误拒绝，不泄露更高 lane action 细节

#### Scenario: operator 请求外部采集动作
- **WHEN** operator lane 调用 `radar.execute action=collect` 或 `action=daily_run`
- **THEN** 系统以与未知 action 等价的安全错误拒绝，且 tools/list 的 action enum 不包含这两个动作

#### Scenario: operator 列出真实 action
- **WHEN** operator 完成 initialize 和 tools/list
- **THEN** discovery 只包含当前 binary 真实 backed 且该 lane 允许的 actions

#### Scenario: Agent 建议修改 Profile
- **WHEN** Agent 判断用户偏好可能变化
- **THEN** MCP 只能返回可审查的 `radar profile set ...` suggestion，不得直接修改 Profile

### Requirement: Search 与 resources 必须提供个人化安全投影
`radar.search` SHALL 支持 `opportunities|items|editions` view，并默认使用 active profile。resources MUST 至少提供 active profile 安全摘要、最新/指定 Edition、机会、证据、runs、source status 与 capabilities；大 payload SHALL 通过 resource ref 读取。

#### Scenario: 搜索个人机会
- **WHEN** consumer 调用 `radar.search` view=opportunities 且未传 profile ref
- **THEN** 返回 active profile 的 compact personal opportunity refs、三类分数和 reason codes，不返回其他 Profile 数据

#### Scenario: 读取 planned capability
- **WHEN** consumer 读取 `radar://capabilities`
- **THEN** 可看到 remote endpoint 等 `planned|blocked|unavailable` 项及 next action，但这些项不出现在 tools/list

### Requirement: stdio transport 必须遵守真实 lifecycle 与恢复语义
stdio stdout MUST 只承载 MCP JSON-RPC frame，进程 SHALL 存活到 stdin 关闭或 signal。断线重连 MUST 通过 run/edition ref lookup/reconcile，MUST NOT 自动重放 `collect` 或 `daily_run`。

#### Scenario: 完成 initialize 后保持运行
- **WHEN** host 建立 stdio session 并完成 initialize
- **THEN** server 持续响应 tools/resources/prompts 请求，不在输出 ready 后退出

#### Scenario: collect 响应丢失后重连
- **WHEN** host 在 collect 提交后断线且 outcome unknown
- **THEN** host/server 先按 run ref 查询；没有新的显式确认时不得再次请求平台

### Requirement: MCP 调用必须 append 脱敏审计且只允许 CLI 读取
每个 tool call MUST append 一条 `radar.mcp.audit.v1`，至少包含时间、脱敏 principal ref、lane、tool/action、args digest、outcome 与相关 run/edition ref。审计文件 MUST NOT 通过 MCP、Workbench 或 DSH 暴露，唯一读取入口为 `radar audit tail`。

#### Scenario: feedback_add 成功
- **WHEN** curator 成功 append 反馈
- **THEN** 返回前写入一条不含原始正文/秘密的 audit event，并可由 `radar audit tail` 读取

#### Scenario: MCP consumer 请求审计 resource
- **WHEN** consumer 尝试猜测或访问 audit URI
- **THEN** server 返回 resource not found，不披露文件路径或事件内容

### Requirement: Hermes canary 必须只把 Radar 当作真源
Hermes 用户级本地 Skill SHALL 默认使用 reader lane，读取已经完成的 Morning Edition 和安全 resources。Hermes MUST NOT 充当采集 scheduler、Profile owner、Edition store 或 production approver；memory 冲突时 MUST 以 Radar profile revision 和 edition ref 为准。

#### Scenario: 早晨已有 Edition
- **WHEN** Hermes brief 发现最新 Edition ready
- **THEN** 输出机会、个人适配原因、证据风险和下一步，并引用 edition/profile refs

#### Scenario: 早晨没有 Edition
- **WHEN** 最新 Edition absent、stale、empty 或 degraded 到不可用
- **THEN** Hermes 解释原因并给出可运行的 Radar 命令，不自动触发 collect

#### Scenario: 用户明确保存机会
- **WHEN** 用户确认保存且 Hermes 会话已提升到 curator lane
- **THEN** Hermes 可调用 `feedback_add`，但仍不得修改 Profile 或启动下游生产

#### Scenario: 用户要求形成做剧提案大纲
- **WHEN** 用户要求 Hermes 基于某个个人机会起草方向
- **THEN** Hermes 可输出引用 opportunity、edition、profile revision 和 evidence refs 的非 canonical draft，并明确仍需人工审查和目标 owner receipt

### Requirement: 公共 Skill、remote endpoint 与 A2A 必须保持未发布
在 14 天单人 canary 和后续 5–8 个隔离 Profile/用户验证通过前，系统 MUST 将公共 Hermes Skill、remote endpoint 与 A2A 标为 `planned|unavailable`。它们不得进入安装文档的默认成功路径或 MCP discovery。

#### Scenario: canary 尚未完成
- **WHEN** 用户运行 `radar mcp capabilities --json`
- **THEN** 本地 stdio 可为 ready，但 public skill、remote endpoint 与 A2A 显示未就绪及明确晋级条件

### Requirement: Reader 可见 resources 必须零外部副作用

MCP resources MUST NOT 触发网络抓取或平台后端调用。`radar://sources/status` SHALL 只报告本地状态（login material 存在性、账号池描述符、playwright 模块、DB）与最近一次持久化采集回执（状态与 degraded layers）；实时网络探测（firecrawl 可达性、xiaohongshu 后端/登录态）只属于 CLI `radar doctor`。

#### Scenario: reader 读取 sources/status
- **WHEN** 任意 lane 读取 `radar://sources/status`
- **THEN** 响应只包含本地检查与最近采集回执，不发起任何网络请求、平台后端调用或浏览器动作

#### Scenario: firecrawl 可达性探测
- **WHEN** 用户运行 `radar doctor`
- **THEN** firecrawl 检查使用 origin 可达性探测（GET），不消耗真实抓取配额

### Requirement: MCP 可见 mutation 必须幂等且复用可审计

MCP 可见的本地写 action（`score`、`cluster_build`、`edition_build`）SHALL 具有自然键身份：相同输入的重复调用返回既有结果与回执，MUST NOT 追加重复数据行。审计账本 SHALL 在条目命中自然键复用时携带 `idempotent_reuse: true`；`denied` outcome MUST 只用于 lane/权限拒绝，运行失败使用 `error`。

#### Scenario: operator 重复构建 Edition
- **WHEN** operator 连续两次 `radar.execute action=edition_build` 且输入不变
- **THEN** 两次返回同一 editionRef，第二次审计条目带 `idempotent_reuse: true`，morning_editions 不新增行

#### Scenario: 同日重复 score
- **WHEN** 同一数据同日重复执行 `score`
- **THEN** runs 表只保留一个该结果指纹的 score 回执

