# radar-cli-agent-contract Delta

## MODIFIED Requirements

### Requirement: CLI 必须提供完整的个人化命令面

CLI SHALL 另外提供 `schedule show`、`schedule install --backend auto|systemd|launchd|windows`、`schedule session-plan --runtime grok|claude|both`。未知 backend/runtime MUST 以稳定错误码拒绝。`session-plan` MUST 走标准 envelope，且 MUST NOT 触发采集。

#### Scenario: session-plan JSON
- **WHEN** 用户运行 `radar schedule session-plan --runtime grok --json`
- **THEN** envelope `command=radar.schedule.session-plan`，`data.spec=radar.schedule.session_plan.v1`，actions 含可粘贴的 `/loop` 命令

#### Scenario: 非法 backend
- **WHEN** 用户运行 `radar schedule install --backend cron`
- **THEN** CLI 以 `backend_invalid` 失败，不写任何单元文件
