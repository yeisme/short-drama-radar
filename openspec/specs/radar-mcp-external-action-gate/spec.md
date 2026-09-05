# radar-mcp-external-action-gate Specification

## Purpose
TBD - created by archiving change radar-mcp-external-action-gate-v1. Update Purpose after archive.
## Requirements
### Requirement: Radar SHALL keep external collection actions out of MCP

`collect` 与 `daily_run` SHALL 仅由 CLI/owner scheduler 执行，不得出现在 MCP discovery 或 dispatch。

#### Scenario: MCP client requests collect

- **WHEN** 客户端发现或直接调用 `collect`/`daily_run`
- **THEN** Radar SHALL 将其视为 unknown/unavailable 且不产生外部副作用

