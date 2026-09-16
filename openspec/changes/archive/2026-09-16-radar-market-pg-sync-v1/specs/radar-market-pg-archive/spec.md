## ADDED Requirements

### Requirement: 市场域数据必须可归档到用户提供的 PostgreSQL
系统 SHALL 提供 `radar market sync --to pg`，把 allowlist 内的市场域表（sources/batches/observations/evidence/signals/work_mappings/briefs/reviews 及资格、采样、来源审阅回执）同步到用户提供 PostgreSQL 的 `radar_archive` schema。SQLite 与 PG 两侧 MUST 使用 Drizzle 同一 schema 定义的双方言实现，PG 侧 DDL MUST 集中在 db 层（与 sqlite 侧 `migrate()` 同一约定），业务读写 MUST NOT 拼裸 SQL。个人阅读/关注状态、Profile/feedback、assignment、runs 与旧两平台管线表 MUST NOT 进入同步 allowlist。

#### Scenario: 首次全量同步
- **WHEN** 本地已有观测、信号与简报，owner 首次执行 `radar market sync --to pg`
- **THEN** allowlist 各表全部行写入 `radar_archive`，facts 报告逐表 `rows_synced`，本地 SQLite 内容零变化

#### Scenario: 个人状态不出库
- **WHEN** 本地存在 reader 已读、watch 关注与 personal Profile
- **THEN** 同步后 PG 中不存在这些表的任何行，allowlist 排除是显式可审计的

### Requirement: 同步必须幂等且 append-only
同步 MUST 以各表幂等键（ref 或 ref+revision 等，与 SQLite 主键一致）执行 `ON CONFLICT DO NOTHING` 写入；冲突行 MUST 回查 `payload_digest`：一致记 `reused`，不一致报 `sync_conflict` 并中止该表。PG 侧已有行 MUST NOT 被 UPDATE 或 DELETE，不可变证据在副本侧同样不可改写。

#### Scenario: 断线后重放同一范围
- **WHEN** 一次同步中断后重跑同一命令
- **THEN** 已存在的行全部记 `reused`，行数不变，无重复无改写

#### Scenario: 副本行被篡改
- **WHEN** PG 中某行的 payload 被外部改动后与本地同键行 digest 不一致
- **THEN** 报 `sync_conflict`（表名＋幂等键＋两侧 digest 摘要），该表中止且零改写，其他表不受影响

### Requirement: 同步必须可断点续传
系统 MUST 在 SQLite 侧 `market_sync_state` 持久化逐表游标与 `target_fingerprint`，且 MUST 只在 PG 事务提交成功后推进游标。更换目标实例 MUST 报 `sync_target_changed`，须显式确认；游标损坏 MUST 报 `cursor_invalid` 并提示显式全量重放。

#### Scenario: 块间进程死亡
- **WHEN** 同步在两个块之间被杀死后重跑
- **THEN** 从上一已提交块继续，最终行数与一次性同步一致

#### Scenario: 换了一个 PG 实例
- **WHEN** 连接串指向的 host/db 与已存 `target_fingerprint` 不同
- **THEN** 拒绝续传并要求 `--allow-target-change`，不静默混写两条游标线

### Requirement: 副本一致性必须可对账
系统 SHALL 提供 `radar market sync --to pg --verify`：零写入地逐表比对行数并按幂等键有序抽样（每表至多 100 行）比对 `payload_digest`；不一致 MUST 逐条列出并以非零码退出。

#### Scenario: 对账发现缺行
- **WHEN** PG 侧某表行数少于本地
- **THEN** verify 报告该表差异明细，退出码非零，两侧均零写入

### Requirement: SQLite 必须保持唯一真源
PG 副本 MUST NOT 回写 SQLite，同步失败 MUST NOT 影响任何本地读写路径；同步命令 MUST NOT 修改市场表、来源 readiness、信号修订或简报，只允许追加 `market_sync_state`。

#### Scenario: PG 不可用时的本地使用
- **WHEN** PG 连接失败报 `pg_unavailable`
- **THEN** 本地 observe/analyze/brief/reader 等全部命令行为不变，重跑 sync 即可续传
