# radar-cli-agent-contract Specification

## Purpose
TBD - created by archiving change personalized-radar-agent-experience-v1. Update Purpose after archive.
## Requirements
### Requirement: CLI 必须提供完整的个人化命令面

CLI SHALL 提供 `profile create|show|set|activate`、`feedback add`、`cluster build`、`edition build|show`、`canary report`、`import --csv`，并 MUST 保留 `doctor|collect|score|card|run|runs`。所有命令 MUST 通过共享 application service 访问领域状态。数值型 flag（如 `--limit`）MUST 校验取值范围并以稳定错误码拒绝非法值，MUST NOT 静默降级为 NaN 或空结果。

CLI SHALL 另外提供 `schedule show`、`schedule install --backend auto|systemd|launchd|windows`、`schedule session-plan --runtime grok|claude|both`。未知 backend/runtime MUST 以稳定错误码拒绝。`session-plan` MUST 走标准 envelope，且 MUST NOT 触发采集。

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

#### Scenario: session-plan JSON
- **WHEN** 用户运行 `radar schedule session-plan --runtime grok --json`
- **THEN** envelope `command=radar.schedule.session-plan`，`data.spec=radar.schedule.session_plan.v1`，actions 含可粘贴的 `/loop` 命令

#### Scenario: 非法 backend
- **WHEN** 用户运行 `radar schedule install --backend cron`
- **THEN** CLI 以 `backend_invalid` 失败，不写任何单元文件

### Requirement: 默认输出必须是简短的人类摘要
未指定机器模式时，CLI SHALL 输出英文 summary，包含状态、最重要事实和一个主要 next command。默认输出 MUST NOT dump 完整 JSON、原始数据库行或大列表。

#### Scenario: Edition 构建成功
- **WHEN** 用户运行 `radar edition build` 且未传输出 flag
- **THEN** stdout 显示 edition ref、entry 数、degraded/empty 状态和一个可运行的 `radar edition show ...` 命令

### Requirement: JSON 输出必须使用仓库标准 envelope
所有 `--json` 命令 MUST 输出一个合法 JSON object，顶层字段限于 `spec_version`、`mode`、`command`、`status`、`summary`、`facts`、`actions`、`evidence`、`confidence`、`data`、`error`。必填字段为 `spec_version/mode/command/status`，status 仅为 `success|partial|failed`。

#### Scenario: JSON 成功结果
- **WHEN** 用户运行 `radar profile show --json`
- **THEN** stdout 只有一个 envelope object，`mode=json`，command id 符合 `radar.profile.show`，Profile payload 位于 `data`

#### Scenario: JSON 失败结果
- **WHEN** 用户读取不存在的 Edition
- **THEN** stdout 返回 `status=failed` 和结构化 `error.code/message/suggestion`，进程以非零退出码结束

### Requirement: Agent 输出必须稳定且紧凑
所有支持机器消费的命令 SHALL 支持 `--agent`，每行一个 `key=value`。输出 MUST 包含 `spec_version=1.0`、`mode=agent`、规范化 command id 和 status；其余字段使用 `fact.*`、`action.*`、`evidence.*`、`metric.*` 或 `error.*` 前缀。

#### Scenario: Agent 获取最新 Edition
- **WHEN** Agent 运行 `radar edition show latest --agent`
- **THEN** 输出只包含单行安全值、Edition/Profile refs、关键计数、状态和 resource/next command，不内嵌完整 entries

#### Scenario: 值包含换行或秘密
- **WHEN** 下游摘要包含多行文本或敏感配置值
- **THEN** renderer 将其省略、归一化或脱敏，agent output 仍保持单行值且不泄露秘密

### Requirement: 长任务事件输出必须是有序 NDJSON
`collect` 与 `run` SHALL 支持 `--events`，按行输出 `start/progress|fact|warning|evidence/end|error`，每条包含递增 `seq`，并在可用时包含 `run_id`。stream 开始后的失败 MUST 以最终 error event 结束并返回非零退出码。

#### Scenario: 完整 daily run 事件流
- **WHEN** 用户运行 `radar run --events`
- **THEN** 第一行是 start，阶段事件按 collect/score/cluster/card/edition 顺序出现，最后一行是带最终 status 的 end

#### Scenario: collect 中途失败
- **WHEN** 外部采集层在 start 后发生不可恢复错误
- **THEN** 系统输出脱敏 error event 作为最后一行，不再输出伪成功 end

### Requirement: 预发布 JSON 草案必须在首个公开版本前一次性迁移
现有 `{ok,app,command,data,errors}` 格式 SHALL 被视为未发布的 `0.0.x` 草案。实现 MUST 在同一 change 中更新本仓脚本、fixtures 与测试，并 MUST 在首个公开版本只发布标准 envelope；系统不为该草案提供长期 legacy mode。

#### Scenario: 仓内消费者迁移完成
- **WHEN** 执行 CLI contract test matrix
- **THEN** 所有仓内脚本只解析标准 envelope，且没有 fixture 或文档继续声明旧顶层字段稳定

#### Scenario: card payload 作为 data 返回
- **WHEN** 用户运行 `radar card <date> --json`
- **THEN** envelope 使用新顶层合同，而 `data.contract` 仍为不变的 `short-drama-radar.card.v1`

### Requirement: 所有输出必须遵守 stdout、stderr 与脱敏边界
stdout MUST 只承载选定输出协议；诊断 SHALL 写 stderr。CLI MUST NOT 输出 cookie、token、Authorization、代理密码、secret store 内容、raw prompt/provider payload 或完整思维链。

#### Scenario: doctor 发现凭据已配置
- **WHEN** `radar doctor` 检查用户级凭据来源
- **THEN** 只显示 source type、configured 状态或脱敏 handle，不显示真实值

#### Scenario: JSON 模式发生诊断警告
- **WHEN** command 产生可恢复 warning
- **THEN** JSON stdout 仍是单个合法 object，警告进入结构化 facts/data 或脱敏 stderr，不混入额外文本

