## 0. 执行约定

G1–G3 对应分组 1–3。每个 task 是单一交付单元；lane 是依赖/路径规划，不授权自动子 Agent。默认同一 writer 串行推进；不同 owner 的并行必须另有明确授权。

Lane 划分：Lane A=外部依赖 `radar-hongguo-catalog-parsing-v1`（红果解析清洗，不在本 change 实现）；lane=gate-model（规则与决定）、lane=review-batch（批量审核与 promote）、lane=quality（质量记录与 health）三条主线在分组 1 之后可并行；lane=verification/final-gate 收口。只有 3.4 依赖 Lane A 完成，其余任务不等待 Lane A。

验证命令中的 market-work-gate、market-work-review-batch、market-observation-quality 等测试文件与新增 radar market 子命令均为拟新增，先实现对应文件/入口再执行；现有 bun test/typecheck/test:integration 和 openspec validate 可直接使用。unit 文件放 test/unit；integration 文件放 test/integration 并由现有证据 runner 调用。所有任务遵循 AGENTS.md：中文文档、英文 CLI/日志/代码注释；复杂逻辑、状态机、并发及不直观夹具必须解释依据，不记录完整思维链。

每次失败先分类 introduced/pre-existing/concurrent/environmental/ambiguous；只修 owned slice。focused 检查在实现期执行，全量门仅在代码与文档稳定后运行。

## 1. G1 入库门规则与决定记录

- [x] 1.1 定义入库门规则集与决定合同；owner=radar；scope=src/market 的 gate domain 类型与校验；依赖=本 design；lane=gate-model；验收=`radar.work_ingestion_gate.v1` 四条规则、`radar.work_gate_decision.v1` 字段、原因码注册表完整，非法规则集/未知原因码拒绝；验证=bun test test/unit/market-work-gate.test.ts；预期=S01/S03 的合法/非法分支明确；失败复查=核对字段来源与既有 WorkMapping/observation 类型兼容。
- [x] 1.2 增加 Drizzle schema、索引与增量迁移；owner=radar；scope=src/db 的 market_work_gate_decisions、market_work_review_batch_receipts、market_observation_quality 三表；依赖=1.1；lane=gate-model；验收=旧库可打开、CREATE IF NOT EXISTS 可重入、不删除旧数据；验证=bun run scripts/integration-test-run.ts bun test test/integration/market-work-gate-storage.test.ts；预期=新库/旧库/迁移重入均通过；失败复查=重放 disposable 旧库并核查事务边界。
- [x] 1.3 实现 gate evaluate 纯函数；owner=radar；scope=四规则只读评估；依赖=1.1；lane=gate-model；验收=同输入同 gate_version 结果确定，逐规则输出 rule_results 与原因码，`required_field_coverage` 首版按 `catalog-fields.v1` 字段集；验证=bun test test/unit/market-work-gate.test.ts；预期=S03/S04/S10 的 fixture-only、字段缺失、身份未印证分支通过；失败复查=打印脱敏规则输入差异，不改阈值掩盖数据问题。
- [x] 1.4 实现决定记录服务；owner=radar；scope=decision repository/service；依赖=1.2、1.3；lane=gate-model；验收=决定不可变、重复记录幂等、重评估新 decision_ref、operative decision 绑定 head revision 与现行 gate_version；验证=bun test test/unit/market-work-gate-decisions.test.ts；预期=S02/S06 的陈旧决定失效分支通过；失败复查=在事务中途注入故障，确认零部分提交。

## 2. G2 批量 review 与门控 promote

- [x] 2.1 实现 work gate show/report 只读 CLI；owner=radar；scope=规则集展示与评估投影；依赖=1.4；lane=review-batch；验收=verdict 分布、原因码计数、逐作品明细，缺参/非法 ref 给英文具名错误；验证=bun test test/unit/market-work-gate-cli.test.ts；预期=S03/S05 的只读路径零写入；失败复查=检查 handler 不绕过服务直接读表改义。
- [x] 2.2 实现 review-batch 与幂等回执；owner=radar；scope=批量决定服务与 CLI；依赖=1.4；lane=review-batch；验收=按来源/批次筛选 head=candidate，一次事务记录全部决定，空范围合法空回执，同键同参重放零新决定、同键异参拒绝；验证=bun run scripts/integration-test-run.ts bun test test/integration/market-work-review-batch.test.ts；预期=S05/S07 含断线按键对账恢复；失败复查=并发反序回放及丢回执恢复。
- [x] 2.3 实现 review-batch-receipt 与 gate decisions 只读查询；owner=radar；scope=回执与决定历史读取；依赖=2.2；lane=review-batch；验收=按键返回原回执、作品决定历史按时间可读，未知键具名 not_found；验证=bun test test/unit/market-work-gate-cli.test.ts；预期=S07 恢复路径完整；失败复查=核对回执 digest 与 payload 一致。
- [x] 2.4 实现门控 promote；owner=radar；scope=promote 服务与 CLI，复用 reviewWorkIdentity；依赖=2.2；lane=review-batch；验收=无决定/rejected/陈旧决定分别具名拒绝，通过后 mapping_revision+1 且引用已存证据，`--override-reason` 同事务留 overridden 决定，verified 不被观测降级；验证=bun test test/unit/market-work-promote.test.ts；预期=S06/S08 含信号更正链联动；失败复查=核对同事务原子性，失败时映射与信号均零写入。

## 3. G3 观测质量指标闭环

- [x] 3.1 实现质量记录持久化；owner=radar；scope=ingestCatalog/observe 同事务写 `radar.observation_quality.v1`；依赖=1.2；lane=quality；验收=每批次一对一质量记录、批次重放零重复、无原始 markup/凭据；验证=bun test test/unit/market-observation-quality.test.ts；预期=S09 的 fixture/manual/live 三 origin 分支通过；失败复查=比对批次指纹与质量 digest，不回填历史批次。
- [x] 3.2 实现 health 市场观测质量段；owner=radar；scope=src/pipeline/health.ts 与 health CLI 渲染；依赖=3.1；lane=quality；验收=逐来源覆盖率首末对比、skip 率趋势、超版本化阈值标 regression_flagged（告警非失败门）、无记录批次显式 quality_unavailable；验证=bun test test/unit/market-quality-health.test.ts；预期=S11 的回归与缺数据分支通过；失败复查=核对窗口对齐与分母来源，不用旧数据补位。
- [x] 3.3 锁定 market canary 质量消费合同；owner=radar；scope=planned `radar market canary report` 的质量段契约与拒绝提示文案；依赖=3.2；lane=quality；验收=spec 与 help 明确该报告实现时必须消费质量记录，本变更内仍为 capability_unavailable；验证=bun test test/unit/market-cli.test.ts；预期=planned 能力诚实拒绝不伪成功；失败复查=检查提示不暗示已可用。
- [x] 3.4 绑定清洗后字段覆盖门槛；owner=radar；scope=红果字段集与 parser_version 升级后的 `required_field_coverage` 评估；依赖=Lane A（radar-hongguo-catalog-parsing-v1 完成）、1.3、3.1；lane=quality-after-lane-a；验收=门评估引用清洗后解析质量、新 gate_version 生效、旧版本决定不追溯重判；验证=bun test test/unit/market-work-gate.test.ts（Lane A 字段夹具）；预期=S10 通过；失败复查=核对字段集版本与夹具来源，Lane A 未完成前本任务不得标完成或以跳过代替。

## 4. 验证与完成

- [x] 4.1 补全流程集成故障回放；owner=radar；scope=test/integration/market-work-ingestion.test.ts；依赖=2.4、3.2；lane=verification；验收=observe→candidate→review-batch→reject→补证据→重评估→promote→canonical 更正一条链，重放 batch 零重复、断线按键对账、旧合同不回归；验证=bun run test:integration；预期=S04–S09 链路证据保留；失败复查=按原 run/receipt 定位单一失败阶段。
- [x] 4.2 软件稳定后运行最终门并同步本地文档；owner=radar；scope=本 change、产品/接口文档；依赖=4.1、3.3；lane=final-gate；验收=新旧合同、类型、全部测试及 strict spec 通过；验证=bun run typecheck；bun test；bun run test:integration；openspec validate radar-work-ingestion-gate-v1 --strict --no-interactive；预期=全部退出 0 且 3.4 在 Lane A 完成前保持未勾选；失败复查=先归因并行/历史问题，只修本次引入项。
