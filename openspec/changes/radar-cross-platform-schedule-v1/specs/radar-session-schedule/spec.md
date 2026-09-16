# radar-session-schedule Specification

## ADDED Requirements

### Requirement: session-plan 只投影不执行

`radar schedule session-plan` SHALL 生成 `radar.schedule.session_plan.v1`，包含 Grok `/loop`、Grok `scheduler_create` 字段、Claude `/loop` 与 Claude Scheduled Tasks cron 载荷。该命令 MUST NOT 启动常驻进程、MUST NOT 调用 Claude/Grok 调度 API、MUST NOT 联网采集。

#### Scenario: 默认只读巡检
- **WHEN** 用户运行 `radar schedule session-plan --runtime both --json`
- **THEN** `data.jobs` 含 doctor/edition/brief 只读巡检，prompt 自包含，且不包含 `radar collect`、`radar run` 或 `market observe --confirm-live`

### Requirement: session 不得冒充墙钟采集

session 计划 MUST 在 `limitations` 中声明：Grok 间隔不是日历时刻；Claude `/loop` 随当前会话结束；Claude Scheduled Tasks 仍依赖 Claude 运行时。系统 MUST NOT 把 session 成功读取旧 Edition 记为当天 live collect。

#### Scenario: 会话关闭
- **WHEN** 用户只启用了 session-plan 而没有 OS timer
- **THEN** doctor 的 schedule 检查仍为 unavailable/blocked，不得显示已调度采集

### Requirement: Agent 运行时保持为消费者

Hermes、DSH、Claude、Grok MUST 通过 CLI 打印的真实命令创建自己的 loop/task。Radar MUST NOT 成为调度引擎，MUST NOT 在 MCP 上暴露 collect/daily_run。

#### Scenario: Grok 使用投影
- **WHEN** Agent 读取 session-plan 的 `actions[].command`
- **THEN** 命令是可直接粘贴的 `/loop ...` 或明确的 `scheduler_create` 字段，而不是 Radar 内部模块路径
