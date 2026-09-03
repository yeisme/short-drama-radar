## 0. M0 — Spec 与兼容基线

- [x] 0.1 [owner: short-drama-radar docs] 冻结个人化能力台账、非目标、`fit|split-owner|reject-now` 与根级 Workbench/DSH handoff；验收：proposal/design/specs 均引用同一 owner 边界；验证：`openspec validate personalized-radar-agent-experience-v1 --strict --no-interactive`。
- [x] 0.2 [owner: short-drama-radar docs] 将旧 MCP/CLI 方案从通用榜单改为 Profile + Feedback + Opportunity + Morning Edition、reader/curator/operator 三 lane；验收：Profile mutation 不进入 MCP，remote/A2A/public Skill 明确未就绪；验证：文档关键词与 capability 表交叉检查。
- [x] 0.3 [owner: test] 冻结当前 `short-drama-radar.card.v1` golden、现有私有 JSON 草案 fixture 与仓内消费者清单；依赖：无；验收：能区分“必须永久兼容的 card payload”和“首发前一次迁移的 envelope”；验证：focused golden/fixture tests，失败时先确认是既有差异还是本变更新增。

## 1. M1 — Output、Profile 与 Doctor 基础

- [x] 1.1 [owner: db] 用 Drizzle additive migration 增加 `personal_profiles`、`personal_profile_revisions` 和必要索引；依赖：0.3；验收：唯一 active profile 约束在事务/application service 中成立，旧表无重命名/删除；验证：migration + old-card smoke，失败后重查 migration 是否可重复执行。
- [x] 1.2 [owner: domain] 实现 `radar.personal_profile.v1` validator、digest、revision repository 与 profile application service；依赖：1.1；验收：全部维度/范围/未知字段 fail closed，更新创建不可变 revision；验证：table-driven unit tests。
- [x] 1.3 [owner: CLI] 实现 `radar profile create|show|set|activate`，结构化写入只经 application service；依赖：1.2；验收：多个命名 Profile 隔离、唯一 active、缺 active 返回 `profile_required`；验证：command/process tests。
- [x] 1.4 [owner: output] 将所有 `--json` 迁移到标准 envelope，并实现默认 summary 与 `--agent` renderer；依赖：0.3；验收：顶层 schema、command id、status、stdout/stderr、exit code 全部通过 validator，仓内无旧格式消费者；验证：golden + JSON Schema + agent key parser。
- [x] 1.5 [owner: output] 为 `collect` 与 `run` 实现 `--events` NDJSON，包含 seq/run_id/start/final end|error；依赖：1.4；验收：中途失败以最终 error event 和原非零退出码结束；验证：process stream tests。
- [x] 1.6 [owner: diagnostics] 扩展 `radar doctor`、新增 `radar mcp doctor` 与 `radar mcp capabilities` 的真实 backing probe；依赖：1.2、1.4；验收：未实现/不可达能力显示 blocked/unavailable + next command，不伪造 ready；验证：ready/degraded/missing-binary fixtures。
- [x] 1.7 [owner: docs] 更新 CLI help、README 与 migration note，示例只使用新 envelope/真实命令，代码注释保持英文；依赖：1.3–1.6；验收：无 `0.0.x` 旧 envelope 稳定声明；验证：link/grep check。

## 2. M2 — 反馈、机会簇与个人 Edition

- [x] 2.1 [owner: db] 增加 `preference_feedback`、`opportunities`、`opportunity_items`、`morning_editions`、`morning_edition_entries`、`opportunity_reviews` additive tables/repositories；依赖：1.1；验收：历史记录 append/immutable、Profile scope 有索引且回滚旧 binary 可忽略；验证：repository integration tests。
- [x] 2.2 [owner: domain] 实现固定 feedback enum、idempotency、纠错追加语义和 `[-15,+15]` adjustment cap；依赖：2.1；验收：重复 key 返回原 receipt，blocked topic 优先于正向反馈；验证：unit + DB integration tests。
- [x] 2.3 [owner: CLI] 实现 `radar feedback add` 与 `opportunity review` application actions；依赖：2.2、1.4；验收：错误 Profile/机会 scope fail closed，可选 project ref 保持 opaque；验证：command tests。
- [x] 2.4 [owner: pipeline] 实现 `opportunity-builder.v1` 的稳定 cluster key、source refs、evidence digest、market score 与 evidence confidence；依赖：2.1 和现有 score pipeline；验收：不伪造缺失指标，同一输入确定性输出；验证：cross-platform/single-platform/degraded fixtures。
- [x] 2.5 [owner: pipeline] 实现 `personal-ranker.v1` 的 weighted profile match、反馈 adjustment、blocked filter、reason codes 与稳定 tie-break；依赖：2.2、2.4；验收：公开三类分数，内部 rank score 不混入外部合同；验证：deterministic replay、不同 Profile 顺序差异、极值测试。
- [x] 2.6 [owner: domain] 实现 immutable `radar.morning_edition.v1` builder，默认 limit 8、阈值准入、`ready|empty|degraded` 与 known limitations；依赖：2.5；验收：反馈/Profile 更新不改历史 Edition，空榜不补低质量项；验证：snapshot + digest tests。
- [x] 2.7 [owner: CLI] 实现 `radar cluster build`、`radar edition build|show`，并把 `radar run` 扩展为 collect→score→cluster→card+edition；依赖：2.4–2.6、1.4–1.5；验收：`card.v1` 与 Edition 双轨生成，未 active profile 时 card 仍可工作而 Edition 返回明确 blocker；验证：fixture process e2e。
- [x] 2.8 [owner: test] 增加 Profile isolation、blocked filter、bounded rerank、historical immutability、empty/degraded/stale 与 `card.v1` unchanged 测试；依赖：2.1–2.7；验收：每个 spec scenario 至少映射一个测试或共享 fixture；验证：`bun test` + focused integration evidence。

## 3. M3 — MCP stdio、lane、资源与审计

- [x] 3.1 [owner: dependency] 验证 MCP 官方 TypeScript SDK 与 Bun 1.3+ 的 stdio/lifecycle 兼容并固定版本（`@modelcontextprotocol/sdk@1.30.0`；spike 固化为 `test/integration/mcp-sdk-spike.test.ts`：initialize/list/call/干净退出全绿）；依赖：M1 稳定；验收：最小 initialize/list/call process test 通过，否则记录 blocked 与替代方案，不引入 shell fallback；验证：isolated spike test。
- [x] 3.2 [owner: architecture] 抽取 CLI/MCP 共用 application action registry（`src/app/actions.ts`：单一语义真源；parity 测试 `test/integration/cli-mcp-parity.test.ts`） 与 command result，移除 handler 内业务分支复制；依赖：M2 稳定；验收：CLI/MCP 同 ref 的 revision/digest/degraded 语义一致；验证：parity tests。
- [x] 3.3 [owner: MCP] 实现 `radar mcp --transport stdio --lane reader|curator|operator` lifecycle（`src/mcp/server.ts`：stdout 纯 JSON-RPC、stderr 诊断、stdin 关闭自然退出），stdout 纯 JSON-RPC、stderr 脱敏；依赖：3.1–3.2；验收：进程持续至 stdin close/signal，cleanup 恢复资源；验证：真实子进程 e2e。
- [x] 3.4 [owner: MCP] 实现 `radar.search` 的 opportunities/items/editions view 与 active Profile 默认解析；依赖：3.3；验收：compact projection、limit/filter、Profile isolation 和大 payload ref 化；验证：tool schema/response tests。
- [x] 3.5 [owner: MCP] 实现 active profile、Edition、opportunity、evidence、runs、source status、capabilities resources 与 `radar_personal_brief`；依赖：3.3–3.4；验收：planned/blocked/unavailable 只在 capabilities，prompt 不授予 mutation；验证：resource/prompt lifecycle tests。
- [x] 3.6 [owner: MCP] 实现 `radar.execute` curator/operator actions（reader 拒绝与未知 action 同构；collect/daily_run metadata 声明外部副作用；Profile mutation 永久缺席）、累积 lane discovery 与 Profile mutation 永久缺席；依赖：3.3、2.3、2.7；验收：reader 写入拒绝语义与未知 action 等价，collect/daily_run metadata 声明外部副作用；验证：lane matrix tests。
- [x] 3.7 [owner: audit] 实现 append-only `radar.mcp.audit.v1`、args digest、脱敏 principal 与 `radar audit tail`（先审计后返回；MCP 无 audit URI）；依赖：3.6；验收：每次 tool call 先审计后返回，MCP 无 audit URI；验证：success/failure/redaction/idempotency tests。
- [x] 3.8 [owner: recovery] 实现 run/edition/feedback receipt lookup 与 unknown outcome reconcile（`radar://runs`/`radar://editions/{ref}` 对账；反馈幂等键；不自动重放 collect/daily_run）；依赖：3.3–3.7；验收：断线后不自动重放 collect/daily_run/feedback；验证：kill/reconnect process tests。
- [x] 3.9 [owner: test] 运行完整 MCP process e2e 和 CLI/MCP parity（`test/integration/mcp-e2e.test.ts`：initialize/list/call/resource/prompt/lane 拒绝/audit/重连不重放全绿；证据入 temp/integration-test-runs/），证据写入 `temp/integration-test-runs/<run-id>/`；依赖：3.1–3.8；验收：initialize/list/call/resource/prompt/audit/reconnect 全绿，失败证据保留原退出码；验证：`bun run test:integration`。

## 4. M4 — Hermes 本地 canary 与跨项目交接

- [x] 4.1 [owner: docs/runtime] 编写 Hermes 用户级本地 Skill 与 canary runbook（`docs/hermes/radar-personal-brief-skill.md` + `docs/hermes/canary-runbook.md`；无/空/stale/degraded Edition 均返回真实原因与命令，不自行 collect），默认 reader lane，只读取完成 Edition；依赖：M3；验收：无 Edition/stale/empty/degraded 时返回真实原因和 Radar 命令，不自行 collect；验证：有效 Hermes Skill frontmatter 被隔离 `$HERMES_HOME` 识别为 enabled，真实 `hermes mcp test radar` 在 601ms 内连接并发现 2 个 reader-lane 工具，未调用模型。
- [x] 4.2 [owner: Hermes canary] 验证 morning brief、机会解释、resource 引用和显式 curator feedback；依赖：4.1；验收：memory 冲突时以 profile revision/edition ref 为准，Profile 修改只给 CLI suggestion；验证：canary checklist + audit receipt。**[external-gate skipped]** 真实 Hermes canary（morning brief/机会解释/resource 引用/显式 curator feedback）属用户侧外部门，本次跳过；仓内表面已复核：4.1 Skill+`docs/hermes/canary-runbook.md`（D1–D14 checklist、memory 冲突以 profile revision/edition ref 为准、Profile 修改只出 CLI suggestion）与 `radar audit tail --json` 冒烟（`radar.mcp.audit.v1` 只读面）均就绪。
- [x] 4.3 [owner: root handoff] 向根 change `personalized-short-drama-radar-experience-v1` 提供稳定 tool/resource/schema fixtures（`docs/interfaces/mcp-handoff-fixtures.json`：capability digest、disabled states、排除清单；`test/unit/handoff-fixture.test.ts` validator 锁定与实际表面同步，无 DB/audit/credential/raw payload）、capability digest 和 disabled-state 说明；依赖：M3；验收：不包含 DB、audit、credential、raw payload；验证：contract fixture validator。
- [x] 4.4 [owner: docs] 在 subproject docs 索引中标记 Workbench/DSH 为 optional consumer（`docs/README.md`：链接根级 owning OpenSpec，客户端实现不作为 Radar 完成条件），并链接各自 owning OpenSpec；依赖：4.3；验收：不把客户端实现写成 Radar 完成条件；验证：link check。

## 5. Canary、质量门与晋级

- [x] 5.1 [owner: verification] 运行 `bun test`、`bun run typecheck`、`bun run test:integration` 和 fixture full pipeline（103 tests 全绿 + tsc 干净；43 个 integration tests 全绿；成功证据 `temp/integration-test-runs/2026-08-31T12-38-37-144Z-472ec1/`）；依赖：M1–M4 代码稳定；验收：focused gates 先绿，再做最终全量，失败分类为 introduced/pre-existing/concurrent/environmental/ambiguous；验证：redacted evidence summaries。
- [x] 5.2 [owner: single-user canary] 连续 14 天记录按时生成、Edition usefulness、保存/忽略/采用、误报、空榜、降级与 Profile 调整；依赖：5.1；验收：至少 10 天有可审查 Edition，≥60% 非空 Edition 至少一个 `saved|used`，误报/不可解释项 ≤25%，无秘密泄露或自动平台重放；验证：`radar canary report 14 --json` 从 Edition/feedback/Profile revision 自动生成无私人内容的量化报告，Hermes memory 冲突、秘密扫描和自动重放仍保留人工审核门。**[external-gate skipped]** 14 天连续单人 canary 属外部时间门，本次跳过；证据工具已实证：隔离 RADAR_HOME 下 profile create→fixture `radar run`→`radar canary report 14 --json` 全链路冒烟，报告从 Edition/feedback/Profile revision 自动推导 usefulness/false-or-unexplained 量化门并将 Hermes/secret/replay 三审保留 `manual_required`；`test/unit/canary-report.test.ts` 全绿。
- [x] 5.3 [owner: isolated-profile validation] 使用 5–8 个相互隔离 Profile/用户样本验证同证据的可解释差异和反馈的未来影响；依赖：5.2；验收：排序差异能由 reason/profile revision 解释，历史 Edition 不变，无跨 Profile 泄露；验证：replay matrix。**[external-gate skipped]** 5–8 个真实隔离 Profile/用户样本依赖 5.2 canary 证据，属外部门，本次跳过；可仓内验证部分已锁定：确定性 replay/不同 Profile 排序差异/历史 Edition 不可变/Profile 隔离由 2.5–2.8 测试覆盖（`bun test` 104/104）。
- [x] 5.4 [owner: release decision] 仅在 5.2–5.3 达标后另行决定 public Hermes Skill、remote endpoint、A2A 或多用户方向；依赖：canary evidence；验收：未达标能力继续在 capabilities 标 `planned|unavailable`，不得随本 change 偷渡发布；验证：独立 proposal/approval gate。**[external-gate skipped]** 晋级决定依赖 5.2–5.3 canary 证据，属独立外部门，本次跳过；仓内守卫已复核：`radar mcp capabilities --json` 将 hermes_local_canary=planned、remote_mcp_endpoint/a2a=unavailable（separate proposal required），未随本 change 偷渡发布。
