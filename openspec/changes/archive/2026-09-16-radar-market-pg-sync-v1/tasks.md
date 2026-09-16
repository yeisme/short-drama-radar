## 0. 执行约定

本 change 目前只有规格文档，未开始实现；任何任务只有在有实际验证记录时才可标完成。每个 task 是单一交付单元；lane 是依赖/路径规划，不授权自动子 Agent。默认同一 writer 串行推进；不同 owner 的并行必须另有明确授权。

验证命令中的 market-pg-*.test.ts、*.integration.test.ts 与 `radar market sync` 命令均为拟新增，先实现对应文件/入口再执行；现有 `bun test`、`bun run typecheck`、`bun run test:integration` 和 `openspec validate` 可直接使用。unit 文件放 test/unit；integration 文件放 test/integration 并由现有证据 runner 调用。所有任务遵循 AGENTS.md：中文文档、英文 CLI/日志/代码注释；业务读写走 Drizzle，DDL 集中在 db 层；不伪造数据、不伪造 PG 集成通过。

真实 PG 验证策略：优先 Testcontainers（`PostgreSqlContainer`）；无 Docker 时用 `RADAR_TEST_PG_URL` 指向的一次性实例；两者皆无则集成文件显式 skip 并在 summary 记录 `pg_integration_skipped`，不得用 mock 冒充真实 PG 通过。DSN 在证据与命令记录中一律 `<redacted>`。

每次失败先分类 introduced/pre-existing/concurrent/environmental/ambiguous；只修 owned slice。focused 检查在实现期执行，全量门仅在代码与文档稳定后运行。

## 1. 双方言存储基础

- [x] 1.1 新增 `postgres`（postgres.js）依赖与 PG 连接层；owner=radar；scope=package.json、src/db/pg-client.ts（单连接、超时上界、`migratePg()` 集中 DDL 建 `radar_archive` schema）；依赖=design §5；lane=foundation；验收=连接/超时/断开有界，DDL 可重入，业务路径无裸 SQL；验证=bun run typecheck；预期=类型零错误，连接参数常量集中在 pg-client；失败复查=确认未引入原生绑定或其他 pg 驱动。
- [x] 1.2 定义 PG 镜像 schema 与 allowlist 单一来源；owner=radar；scope=src/db/pg-schema.ts（pg-core 镜像 12 张市场域表＋`payload_digest`/`synced_at`）与 src/market/sync-tables.ts（allowlist＋幂等键＋游标排序键表）；依赖=1.1；lane=foundation；验收=allowlist 与 design §2 表一一对应，sqlite/pg 两侧列定义由同一常量驱动而非两份手抄；验证=bun test test/unit/market-pg-schema.test.ts；预期=每张 allowlist 表在 pg-schema 存在且幂等键与 SQLite 主键一致，个人/本地状态表被显式排除；失败复查=对照 src/db/schema.ts 主键定义逐表核对。
- [x] 1.3 实现连接来源解析与脱敏诊断；owner=radar；scope=src/config.ts（`pgArchive.url` 合并与类型校验）、src/market/sync-config.ts（env 优先、畸形 DSN 拒绝、target_fingerprint、0600 权限警告、脱敏摘要）；依赖=1.1；lane=foundation；验收=两种来源优先级正确，诊断只含来源类型/脱敏 host/db/schema/指纹前 12 位，全链路无 DSN 明文；验证=bun test test/unit/market-pg-config.test.ts；预期=env/config/缺失/畸形/权限位分支齐全，输出扫描无任何凭据片段；失败复查=用含口令的 DSN 遍历全部错误与正常输出确认零泄漏。

## 2. 同步引擎

- [x] 2.1 新增 SQLite 侧 `market_sync_state` 游标表与集中 DDL；owner=radar；scope=src/db/schema.ts、src/db/client.ts `migrate()`；依赖=1.2；lane=sync；验收=新旧库均可打开，旧库升级不丢数据；验证=bun test test/unit/market-sync-state.test.ts；预期=新库/旧库/迁移重入通过，游标读写走 Drizzle；失败复查=重放 disposable 旧库核查迁移幂等。
- [x] 2.2 实现分块读取与游标推进纯函数；owner=radar；scope=src/market/sync-plan.ts（按表排序键分块、chunk_size 界 1–5000、游标序列化/校验）；依赖=2.1；lane=sync；验收=块边界确定、重复块幂等、损坏游标报 `cursor_invalid`；验证=bun test test/unit/market-sync-plan.test.ts；预期=空表/单块/多块/块间插入新行/损坏游标分支明确；失败复查=打印脱敏游标差异，不用重置掩盖边界错误。
- [x] 2.3 实现幂等 append-only 写入与冲突检测；owner=radar；scope=src/market/sync.ts（`ON CONFLICT DO NOTHING`＋冲突行 digest 回查、`sync_conflict` 中止该表、游标只在 PG 事务提交后推进）；依赖=2.2；lane=sync；验收=重放零改写、同键异 digest 中止且该表游标停在块前、其他表不受影响；验证=bun test test/unit/market-sync.test.ts（引擎逻辑，PG 访问经窄接口注入）＋ 4.1 真实 PG 集成；预期=unit 覆盖冲突分类与事务边界，真实写入归集成；失败复查=在 PG 事务中途注入故障确认游标未推进。
- [x] 2.4 实现 target_fingerprint 门与 `--verify` 对账；owner=radar；scope=src/market/sync.ts（目标变更 `sync_target_changed`/`--allow-target-change`；verify 行数比对＋每表至多 100 行 digest 抽样，零写入）；依赖=2.3；lane=sync；验收=换目标被拒且可显式确认，verify 检出篡改并逐条列出；验证=bun test test/unit/market-sync.test.ts ＋ 4.1 集成；预期=指纹变更/确认/verify 通过/verify 检出分支齐全；失败复查=确认 verify 无任何 PG 写入语句被执行。

## 3. CLI 与输出合同

- [x] 3.1 注册 `radar market sync` 命令与 flag 校验；owner=radar；scope=src/market/cli.ts（`group === "sync"` 分支，checkFlags 惯例：`to/chunk-size/verify/reset-cursor/confirm-reset/allow-target-change`）、usage 文案；依赖=2.4、1.3；lane=surface；验收=缺值/非法 flag/未知 `--to` 均具名拒绝，command id 为 `radar.market.sync`；验证=bun test test/unit/market-cli.test.ts；预期=正常/拒绝/恢复提示分支英文可恢复；失败复查=确认 handler 不绕过 sync 服务直连数据库。
- [x] 3.2 接通标准输出与事件流；owner=radar；scope=envelope facts/actions、长同步 start→phase（逐表 `table_synced`）→end、失败终局 error；依赖=3.1；lane=surface；验收=summary/json/agent/events/explain 五面一致且零凭据，`--verify` 失败退出码非零；验证=bun test test/unit/market-output.test.ts；预期=输出扫描无 DSN/口令，events seq 严格递增；失败复查=分别解析 stdout/stderr 检查秘密回显。
- [x] 3.3 更新调度说明为可选挂接；owner=radar；scope=src/market/schedule.ts（show/install 说明文本：sync 不生成不启用定时器，附 owner 自行追加 unit 的示例）；依赖=3.1；lane=surface；验收=既有单元逐键不变，install 产物不含 sync timer；验证=bun test test/unit/market-schedule.test.ts；预期=新旧调度快照差异仅限说明文本；失败复查=比对 install --print 输出确认无新增 unit 文件。

## 4. 真实 PG 集成验证

- [x] 4.1 建立一次性 PG 集成基座；owner=radar；scope=test/integration/market-pg-sync.test.ts（Testcontainers 优先，`RADAR_TEST_PG_URL` 兜底，双缺显式 skip＋summary 记录 `pg_integration_skipped`）；依赖=2.4、3.2；lane=verification；验收=真实 PG 上首同步全量→重放零新增、`--verify` 通过；验证=bun run scripts/integration-test-run.ts -- bun test test/integration/market-pg-sync.test.ts --timeout 60000；预期=证据目录完整且 env.json/command.txt 中 DSN 为 `<redacted>`；失败复查=确认 skip 是环境缺失而非代码失败，environmental 分类不掩盖 introduced。
- [x] 4.2 故障回放：断点续传、冲突与恢复；owner=radar；scope=test/integration/market-pg-sync.test.ts（中途断连后续传行数一致、手工篡改 PG 行触发 `sync_conflict` 零改写、换目标指纹门、损坏游标 `--reset-cursor` 重放）；依赖=4.1；lane=verification；验收=四类故障各产生具名错误码与可恢复终态；验证=同 4.1 命令经证据 runner 运行；预期=每类故障后 `--verify` 或恢复命令给出确定结论；失败复查=按 run/表/块号定位单一失败阶段，不用全量重置掩盖冲突。

## 5. 文档与最终门

- [x] 5.1 同步产品/接口文档；owner=radar；scope=docs/product/global-market-radar.md（归档层章节：命令、凭据来源、append-only 语义、调度挂接边界）与 README 状态段；依赖=4.2；lane=docs；验收=文档只描述已实现行为，命令示例真实可跑；验证=人工核对文档命令与 `--help` 输出一致；预期=无 planned 被写成 ready；失败复查=逐条命令实跑验证。
- [x] 5.2 运行全量门；owner=radar；scope=本 change 全部产物；依赖=5.1；lane=final-gate；验收=类型、全部单测、集成证据、strict spec 通过；验证=bun run typecheck；bun test；bun run test:integration；openspec validate radar-market-pg-sync-v1 --strict --no-interactive；预期=全部退出 0，PG 集成 skip 时 summary 如实记录；失败复查=先归因并行/历史问题，只修本次引入项。
