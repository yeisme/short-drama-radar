## Why

市场观测/作品/信号/简报已可采集落库（2026-09-16 红果 live 采样 24 部作品已验证），但持久化只有本地单文件 SQLite（`~/.short-drama-radar/radar.db`），没有长期归档层：单机故障即丢失全部证据，也无法用 SQL 生态对历史数据做长期分析。用户明确要求对接 PostgreSQL 做数据长期存储，且此本地基础设施在 canary 前被允许。

## What Changes

- 新增 `radar market sync --to pg`：Drizzle 同一 schema 出 sqlite + pg 双方言，把市场域数据（sources/batches/observations/evidence/signals/work_mappings/briefs/reviews 及资格、采样、来源审阅回执）按 ref/revision/digest 幂等 upsert 到用户提供的 PostgreSQL（独立 schema `radar_archive`）。
- SQLite 仍是真源与证据所在；PG 是归档＋分析副本，append-only 语义：冲突只校验 digest，永不改写已有行，内容不一致报 `sync_conflict` 并中止该表，等待 owner 审查。
- 同步可断点续传、可重放：SQLite 侧新增 `market_sync_state` 游标表，按表分块推进并逐块落 checkpoint；`--verify` 对账行数与 digest 抽样。
- 连接串只来自环境变量 `RADAR_PG_URL` 或用户级 config（参照 `RADAR_HOME` 惯例），绝不入库、入日志、入证据、入 fixture；诊断只显示来源类型与脱敏摘要。
- 新增 pg 驱动依赖 `postgres`（postgres.js）：纯 JS 无原生绑定，drizzle-orm 0.44.7 官方 `drizzle-orm/postgres-js` 驱动，Bun 兼容。
- 失败有具名错误码与恢复命令；与调度器的关系显式化：`market schedule show/install` 只增加可选挂接说明，不生成也不启用 sync 定时器。
- 不新增服务端、不做多用户、不开 remote endpoint。多用户 HTTP API（Go+GORM 的 `backend-server/radar-api`）是后续独立决策，不在本变更范围。

## Capabilities

### New Capabilities

- `radar-market-pg-archive`：市场域数据向 PostgreSQL 的幂等 append-only 归档同步、断点续传、副本对账与 SQLite 真源不变量。
- `radar-market-pg-config-safety`：连接串来源与脱敏、具名错误码与恢复路径、调度挂接边界、本地单用户边界。

### Modified Capabilities

无。同步只新增出口，不改写既有市场观测/信号/简报合同；若实现中发现必须改旧合同，先补独立迁移设计。

## Impact

范围为 `src/db/`（pg 镜像 schema 与连接层）、`src/market/`（sync 引擎与 CLI）、`src/config.ts`、`package.json`（新增 `postgres` 依赖）、调度说明与对应测试/文档；代码仍为 TypeScript/Bun＋Drizzle，DDL 仍集中在 db 层。不新增服务端、云同步、多用户或远程 Agent 服务。
