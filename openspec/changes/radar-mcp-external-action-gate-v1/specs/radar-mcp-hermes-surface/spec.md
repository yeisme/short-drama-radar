## MODIFIED Requirements

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

## ADDED Requirements

### Requirement: Reader 可见 resources 必须零外部副作用

MCP resources MUST NOT 触发网络抓取或平台后端调用。`radar://sources/status` SHALL 只报告本地状态（login material 存在性、账号池描述符、playwright 模块、DB）与最近一次持久化采集回执（状态与 degraded layers）；实时网络探测（firecrawl 可达性、xiaohongshu 后端/登录态）只属于 CLI `radar doctor`。

#### Scenario: reader 读取 sources/status
- **WHEN** 任意 lane 读取 `radar://sources/status`
- **THEN** 响应只包含本地检查与最近采集回执，不发起任何网络请求、平台后端调用或浏览器动作

#### Scenario: firecrawl 可达性探测
- **WHEN** 用户运行 `radar doctor`
- **THEN** firecrawl 检查使用 origin 可达性探测（GET），不消耗真实抓取配额
