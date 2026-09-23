## MODIFIED Requirements

### Requirement: session 不得冒充墙钟采集

session 计划 MUST 在 `limitations` 中声明：Grok 间隔不是日历时刻；Claude `/loop` 随当前会话结束；Claude Scheduled Tasks 仍依赖 Claude 运行时。系统 MUST NOT 把 session 成功读取旧 Edition 记为当天 live collect。墙钟调度为客户侧所有：Radar MUST NOT 探测或断言客户侧定时器是否已接线，未接线时不得在任何输出中声称已调度采集。

#### Scenario: 会话关闭
- **WHEN** 用户只消费 session-plan 而未在客户侧创建任何 OS 定时器
- **THEN** Radar 的 doctor 与 schedule 输出不声称当天采集已调度或已执行；当天是否有 live collect 只由真实采集运行证据决定
