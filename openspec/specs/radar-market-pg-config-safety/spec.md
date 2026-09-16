# radar-market-pg-config-safety Specification

## Purpose
约束可选 PG 归档配置、目标身份和输出脱敏，避免凭据泄露及误写目标。
连接来源仅用于配置解析和安全诊断，不授权远端部署、凭据变更或生产库写入。

## Requirements
### Requirement: 连接串必须只来自用户环境变量或用户级配置且全链路脱敏
PG 连接串 MUST 只来自环境变量 `RADAR_PG_URL` 或用户级 config（`RADAR_CONFIG_PATH` / `~/.short-drama-radar/config.json`）的 `pgArchive.url`，env 优先。连接串 MUST NOT 进入 SQLite/PG 业务表、stdout/stderr、events、envelope、`--explain`、集成测试证据或 fixture。诊断输出 MUST 只包含来源类型（`env|config`）、脱敏 host/db/schema 摘要与 `target_fingerprint` 前缀；`market_sync_state` MUST 只存不含凭据的目标指纹。

#### Scenario: 未配置连接串
- **WHEN** env 与 config 均无连接串时执行 sync
- **THEN** 报 `pg_config_missing`，提示两个配置位置，零写入

#### Scenario: 含口令的 DSN 遍历所有输出
- **WHEN** 使用 `postgres://user:secret@host/db` 形式的连接串执行成功与失败路径
- **THEN** stdout/stderr/events/证据文件均不出现 `secret` 或完整 DSN，只出现脱敏摘要

#### Scenario: 认证失败
- **WHEN** PG 拒绝认证
- **THEN** 报 `pg_auth_failed`，只提示检查凭据来源，不回显 DSN 任何片段

### Requirement: 失败必须有具名错误码与恢复命令
同步各失败路径 MUST 返回稳定英文错误码（`pg_config_missing`/`pg_unavailable`/`pg_auth_failed`/`schema_mismatch`/`sync_target_changed`/`sync_conflict`/`cursor_invalid`/`sync_target_unsupported`）并附可执行的恢复命令；MUST NOT 用 catch-all 吞掉具体原因。

#### Scenario: 网络中断
- **WHEN** 同步中途 PG 不可达
- **THEN** 报 `pg_unavailable`，退出码非零，提示重跑同一命令续传

#### Scenario: 游标损坏
- **WHEN** `market_sync_state` 中某表游标 JSON 损坏或越界
- **THEN** 报 `cursor_invalid`，拒绝续传并提示 `radar market sync --to pg --reset-cursor --confirm-reset`（幂等安全的全量重放）

### Requirement: 与调度器的关系必须显式且默认不启用
`radar market schedule show/install` MUST 在说明中把 sync 列为可选挂接（owner 自行追加定时单元的示例），MUST NOT 生成或启用任何 sync 定时器；既有调度单元 MUST 逐键不变。同步 MUST NOT 进入 cutoff/freeze 语义。

#### Scenario: 安装调度单元
- **WHEN** owner 执行 `radar market schedule install`
- **THEN** 写出的单元与既有集合一致，不含 sync timer，说明文本注明启用任何单元都是 owner 显式动作

### Requirement: 本变更必须保持本地单用户边界
同步能力 MUST NOT 新增服务端、多用户能力或 remote endpoint；PG 只作为单用户本地 CLI 的归档与分析副本。多用户 HTTP API（Go+GORM 的 `backend-server/radar-api`）MUST 保持为后续独立决策，不得借本变更标记为 ready 或开始实现。

#### Scenario: 能力探测
- **WHEN** 消费者通过 CLI help 或诊断查询同步能力
- **THEN** 只看到本地 CLI 归档语义，不存在任何 HTTP 端点、多租户或远程写入口

