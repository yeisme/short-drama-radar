## 0. 执行约定

每个 task 是单一交付单元；lane 是依赖/路径规划，不授权自动子 Agent。默认同一 writer 串行推进；lane A（夹具与归因复核）与 lane B（解析器实现）在 1.2 完成后可并行，lane C（测试）依赖对应实现任务。所有任务遵循 AGENTS.md：中文文档、英文 CLI/日志/代码注释；fixture 不含真实 cookie/追踪参数。每次失败先分类 introduced/pre-existing/concurrent/environmental/ambiguous；只修 owned slice。focused 检查在实现期执行，全量门（任务 4.1）仅在代码与文档稳定后运行。

## 1. 复核与夹具（lane A：evidence）

- [x] 1.1 复核 2026-09-16 采样回执的跳过归因；owner=radar；scope=采样回执与 `parseCatalog` 分流逻辑只读分析；依赖=无；lane=A；验收=32 条 `no_work_identity` 与 2 条 `foreign_or_unsafe_link` 逐条归类（导航/播放/登录隐私/外链等），明确是否存在身份提取缺陷；验证=人工核对回执与页面结构并在本任务证据中记录分类计数；预期=得出「全部确属非作品页」或「存在需修复的作品链接形态」之一的结论；失败复查=重新抓取同页对比，不以猜测填分类。
- [x] 1.2 新增脱敏夹具 `test/fixtures/market/hongguo-live-2026-09-16.html`；owner=radar；scope=test/fixtures/market；依赖=1.1（归因分类决定夹具覆盖形态）；lane=A；验收=夹具包含「标题×2+标签串」anchor（含 `夺风华` 类结构示例）、集数文本、无标签 anchor、导航/播放/外链被跳链接形态，无真实 cookie/追踪参数/私密数据；验证=bun test test/unit/market-catalog.test.ts（既有夹具解析不回归）；预期=新夹具文件入库且既有测试全绿；失败复查=对比真实样本结构，缺形态先补夹具再写解析断言。
- [x] 1.3 评估是否扩展 `market-label-mapping.v1` zh 表；owner=radar；scope=src/market/classification.ts；依赖=1.2（需夹具中的真实标签清单）；lane=A；验收=每个拟新增词条（如 `古装`、`先婚后爱` 等）有夹具/真实样本页面证据，未映射标签保持原文+topics 空的行为不变；验证=bun test test/unit/market-classification.test.ts；预期=映射表改动最小且有据，或未改动并说明理由；失败复查=回退词条，不为了提覆盖率而加无证据映射。

## 2. 解析器修正（lane B：parser）

- [x] 2.1 实现 `hongguo-anchor-layout.v1` 结构拆分；owner=radar；scope=src/market/catalog.ts hongguo HTML 解析分支；依赖=1.2；lane=B；验收=「标题×2+标签串」拆出干净 title 与标签串（去重、每 anchor ≤8 个），结构不匹配时 title 保持原文且无标签，reelshort/dramabox/markdown 路径行为不变；验证=bun test test/unit/market-hongguo.test.ts；预期=夹具中粘连标题全部拆净，既有 4 作品夹具断言不回归；失败复查=对照夹具逐条定位拆分边界，禁止用正则猜标题。
- [x] 2.2 接入标签串到 category/topics 消费链；owner=radar；scope=src/market/catalog.ts 与 classification 调用点；依赖=2.1、1.3；lane=B；验收=anchor 标签串优先于 section heading，两者缺失时 category=null；未映射标签原文入 evidence `category_label` 且 topics 空；`field_coverage.category` 口径不变；验证=bun test test/unit/market-hongguo.test.ts test/unit/market-catalog.test.ts；预期=新夹具上 category 覆盖率接近 100%（除结构性无标签项）；失败复查=打印脱敏解析中间态，核对 heading 继承与 anchor 标签优先级。
- [x] 2.3 落地跳过归因解释与可能的身份提取修复；owner=radar；scope=src/market/catalog.ts `identity()` 与回执 limitations；依赖=1.1、2.1；lane=B；验收=若 1.1 发现作品链接形态缺陷则修复 `identity()` 并给出修复前后跳过数对比，否则把归因摘要写入回执 limitations；回执不回显完整可疑 URL；验证=bun test test/unit/market-adapters.test.ts；预期=`no_work_identity` 跳过数有下降或可解释归因文本，既有安全分流（异 host/凭据/明文 http）不回归；失败复查=逐条回放被跳链接，确认无真实作品被误跳。

## 3. 验证（lane C：tests）

- [x] 3.1 新增/扩展 unit 断言覆盖解析清洗全分支；owner=radar；scope=test/unit/market-hongguo.test.ts（或新增 market-hongguo-anchor.test.ts）；依赖=2.2、2.3；lane=C；验收=粘连标题拆分、标签映射命中/未命中、结构不匹配回退原文、heading 与 anchor 标签优先级、跳过归因计数与 limitations 文本；验证=bun test test/unit/market-hongguo.test.ts；预期=全部新断言通过且断言标题不含重复串；失败复查=先确认夹具结构再改断言，不为过测试放宽拆分规则。
- [x] 3.2 新增 integration 回放 observe fixture 路径；owner=radar；scope=test/integration/market-catalog.test.ts 或 market-observe.test.ts；依赖=3.1；lane=C；验收=`--fixture` 路径下新夹具 `field_coverage.category` 接近全量、origin=fixture 不与 live 混淆、证据 payload 无原始 HTML；验证=bun run scripts/integration-test-run.ts bun test test/integration/market-catalog.test.ts；预期=证据目录 temp/integration-test-runs/<run-id>/ 完整、退出码 0；失败复查=查 summary.json/stdout.log 定位失败阶段，只修本变更引入项。

## 4. 文档与全量门（lane D：final-gate）

- [x] 4.1 运行全量门并同步文档；owner=radar；scope=docs/product/global-market-radar.md 已知限制段与本 change；依赖=3.2；lane=D；验收=`bun run typecheck`、`bun test`、`bun run test:integration`、`openspec validate radar-hongguo-catalog-parsing-v1 --strict --no-interactive` 全部退出 0；已知限制段更新为修复后状态（仍声明 readiness=planned、重采样前旧样本不作 canonical 消费）；验证=上述四条命令；预期=全绿；失败复查=先归因 introduced/pre-existing/concurrent，只修本变更引入项。
- [ ] 4.2（可选外部验证）owner 显式重采样；owner=radar-operator；scope=`radar market observe --source hongguo --mode verify-sample --confirm-live`；依赖=4.1、owner 授权；lane=D；验收=新 batch 标题无粘连、category 覆盖率显著提升、candidate mapping 生成新 revision 且旧 24 条证据未改写；验证=执行命令并核对回执 `field_coverage`/`skipped_links` 与 work list；预期=清洗效果在真实页面复现；失败复查=页面改版则回到 1.1 复核结构，不强行调规则凑数。该任务不阻塞软件门，执行与否单独报告。

## 5. 完成证据（2026-09-16）

- 1.1 归因复核：对 `https://novelquickapp.com/category` 做同页只读复核（77 个 anchor = 24 作品 + 45 同 host + 8 外链/非 https）。同 host 被跳链接全部为非作品页：首页/导航 2、分类与题材过滤 34、榜单 5、分页 4；外链为备案/证照外链 6 与非 https 协议（http/mailto）2。无一 `/detail` 作品链接被误跳，结论为「全部确属非作品页」，无身份提取缺陷，`identity()` 无需修复。与采样回执 32/2 的计数差异源于分页与页脚渲染随抓取变化，归因类别一致。
- 1.2 夹具：`test/fixtures/market/hongguo-live-2026-09-16.html`，含标题×2+标签串卡片（含 `夺风华`）、重复/空标签 span、无结构纯文本 anchor、section heading 优先级样本、导航/分类/榜单/分页/外链/mailto 被跳形态；无 cookie/追踪参数/私密数据，封面图用占位路径。
- 1.3 映射表：zh 表新增 34 个词条，全部来自 2026-09-16 真实样本 24 部作品的页面标签（页面证据在夹具与采样 DB 标题串中）；未映射标签行为不变。
- 2.x 解析：真实页面结构离线回放 `field_coverage.category` 由 0/24 修复为 24/24，`episode_count` 24/24；脱敏夹具回放 6/7（唯一缺口为结构性无标签的纯文本 anchor，符合口径）。规则对 NUL 填充文本与空白分裂标题做确定性剥离，结构不匹配回退原文且不产标签。
- 3.x 验证：`test/unit/market-hongguo-anchor.test.ts` 8 个用例全绿；integration 证据 run `temp/integration-test-runs/2026-09-16T08-07-06-459Z-x0321z`（exit 0）。
- 4.1 全量门：`openspec validate radar-hongguo-catalog-parsing-v1 --strict --no-interactive` 通过；`bun test` 301/301 全绿；`bun run test:integration` 91/91 全绿、exit 0（证据 `temp/integration-test-runs/2026-09-16T08-10-38-093Z-ijxyiw`）；`bun run typecheck` 在本变更全部文件零错误，但整仓退出码 2，剩余错误仅位于并行变更 radar-market-pg-sync-v1 的未跟踪文件（`src/db/pg-schema.ts`、`test/unit/market-pg-schema.test.ts`），归因 concurrent，不属本变更修复范围。文档已同步 `docs/product/global-market-radar.md` 已知限制段。
- 4.2（可选 owner 重采样）：未执行，不阻塞软件门。
