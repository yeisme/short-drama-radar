## MODIFIED Requirements

### Requirement: CLI 必须提供完整的个人化命令面

CLI SHALL 提供 `profile create|show|set|activate`、`feedback add`、`cluster build`、`edition build|show`、`canary report`、`import --csv`，并 MUST 保留 `doctor|collect|score|card|run|runs`。所有命令 MUST 通过共享 application service 访问领域状态。数值型 flag（如 `--limit`）MUST 校验取值范围并以稳定错误码拒绝非法值，MUST NOT 静默降级为 NaN 或空结果。

#### Scenario: 从 Profile 到 Edition 的本地流程
- **WHEN** 用户依次创建/激活 Profile、运行 fixture pipeline 并执行 `radar edition build`
- **THEN** CLI 返回可读取的 profile、opportunity、edition 和 evidence refs，不要求启动 MCP 或外部客户端

#### Scenario: 未知命令或 action
- **WHEN** 用户输入未注册的命令或 action
- **THEN** CLI 返回稳定错误码、简短说明和有效 help command，且不执行相近命令猜测

#### Scenario: 非法数值参数
- **WHEN** 用户运行 `radar edition build --limit abc`
- **THEN** CLI 以 `limit_invalid` 稳定错误码失败（`--events` 模式下输出终态 error 事件），不产生静默空 Edition

#### Scenario: 14 天 canary 量化报告
- **WHEN** 用户运行 `radar canary report 14 --profile <ref> --json`
- **THEN** CLI 从不可变 Edition、append-only feedback 与 Profile revision 派生 Edition 天数、usefulness、误报/无解释比例和调整次数，不写第二份真源、不包含私人正文，并将 Hermes/memory、秘密泄漏和自动重放保留为明确人工审核门
