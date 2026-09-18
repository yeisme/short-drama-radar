# 国内外短剧市场变化 Radar

## 产品方向与状态

2026-09-16 新增[漫剧立项决策研究](greenlight-pilot/decision-pack.md)：下一阶段优先验证“选择值得进入的市场和漫剧方向，并根据结果修正判断”。首轮已交付公开来源初筛、三市场深查、候选比较与小样实验设计；原始用户选题基线缺失，真实受众与观看结果尚未取得。先验证人工辅助的完整路径，再据实际障碍决定新增自动化；以下市场观察、个人 Edition、来源资格和十四天验证保持各自原义。

方案日期：2026-09-11。目标是替代用户在多个平台/榜单间反复切换的部分工作：每日 3–5 分钟掌握值得注意的变化，再由 Agent 和 DSH 深看证据。内容变化为主，行业背景为辅；真人短剧与漫剧分别观察，AI 制作方式另有证据标签。

这是已确认方向的设计文档。本地软件面（2026-09-13 OpenSpec radar-market-observation-and-brief-v1 软件门）已交付：观测输入校验、来源/观测/资格存储、来源/配置/资格 CLI、七类命题可比分析、信号修订与更正/恢复、每日简报（supersedes/ready-degraded-empty）、时区/截止/迟到规则、市场调度单元描述（market schedule，写单元不启用）、显式已读/补看/观察清单（含暂停期变化与 source_gap）、跨市场对照、周度回顾、禁区全出口、question context 与回答引用验证、summary/json/agent/events/explain 输出合同、MCP 只读 view/curator/operator 动作/资源（含列表 view）、市场 handoff 向量与读取性能验证（100k 观测下 latest brief 与 20 条补看 p95 均远低于 1s）。既有个人 Profile、反馈、机会、Morning Edition 与 card.v1 保留。真实门仍未完成且必须分别报告：已授权来源的持续资格验证（任务 5.4，须真实来源与权限）、14 天真实观察与用户对照（5.5，须 DSH 真实连接）、付费补缺与发布决定（5.6，须用户授权）；`radar market observe --source hongguo --mode verify-sample --confirm-live` 已接通红果公共目录验证采样（固定页 `https://novelquickapp.com/category`，origin=live，不自动晋级 qualified）。其他来源 observe 仍拒绝。`market canary report` 仍以 capability_unavailable 拒绝。软件、真实来源和浏览器验收状态必须分别报告，不能由本页推断已上线。

### 当前可用的本地基础命令

信号更正已支持market signal correct，必需 --signal、--revision、--reason、--evidence、--outcome（retracted或inconclusive）和--at。它是显式owner操作，追加修订不覆盖旧判断；缺失证据或陈旧revision拒绝。更正会重新进入补看并在新简报优先出现，旧版次保持原digest。周度回顾已支持 market review build/show（前一完整周、四种结果、cutoff 有界、重建幂等）；market signal restore 支持显式恢复审查。

证据上下文入口：`bun run src/cli.ts market question context --signal <ref> --revision <n> --question "为什么这样判断？" --json`。它只提供已存证据和回答约束，不调用模型或发起研究；缺失/禁区证据报错。单条证据用market evidence show并提供同一signal/revision/evidence读取；不能拿其他信号的ref绕过当前策略。MCP 已暴露 market_question view 与 radar_market_brief prompt，回答引用验证（fact 必须引用上下文携带证据）由服务校验；DSH 真实会话接入仍属外部门。

观察清单已有 watch add/list/pause/resume/remove/receipt。使用 `bun run src/cli.ts market watch list --json` 获取列表和reader状态；新增使用 `bun run src/cli.ts market watch add --kind platform --target hongguo --revision <n> --policy-revision <digest> --key <key> --json`。暂停/恢复/取消传 --watch，均要求当前revision与policy；这些动作不写原创作反馈或已读。暂停期与任意窗口的变化汇总已支持 market watch changes --watch <ref> [--since --until]（默认最近暂停期，否则30天；窗口内无采集的来源标 source_gap，不把缺数据当无变化）。

补看入口为 `bun run src/cli.ts market reader catchup --json`，默认最近30天、每页20条，下一页传 --cursor。分页不自动标已读；读者、禁区或信号集合改变后旧cursor返回state_conflict，重新读取即可。受禁区过滤时可能返回空页与next_cursor，仍应按游标继续，不能将空页误判为全部读完。

显式阅读进度已支持 reader show/mark/unread/receipt。先运行 `bun run src/cli.ts market reader show --json` 获取当前reader revision和policy_revision，再用 `bun run src/cli.ts market reader mark --signal <ref> --signal-revision <n> --revision <n> --policy-revision <digest> --key <key> --json` 标记指定修订。撤销使用unread；回执丢失可用reader receipt --key查询，不使用新键重复写入。打开简报或Agent读取不会自动记已读。

本地市场版次已支持 `bun run src/cli.ts market brief build --start 2026-09-10T00:00:00Z --end 2026-09-11T00:00:00Z --json` 和 `bun run src/cli.ts market brief show --json`。构建读取已有信号，不联网，固定输入复用原版次；show使用当前内容禁区，保留原版次ref/digest。当前来源资格不完整，非空版次标degraded。市场调度单元已可生成与安装（market schedule show / install [--print]，analyze 08:50、brief 09:00 本地时区，observe 在来源资格完成前保持 planned）；写入单元不启用 timer，启用为 owner 动作。

基础分析现已支持 `bun run src/cli.ts market analyze --start 2026-09-10T00:00:00Z --end 2026-09-14T00:00:00Z --json`，读取已入库观察并生成首次观察和可比指标信号，不联网。可用 `bun run src/cli.ts market signal show --signal <ref> --revision <n> --json` 回查绑定修订；缺失修订不会回退最新。七类命题（含 listing/topic-mix/cross-market 证据门与版本化排序）、更正生命周期与不可变简报均已交付。

来源检查已支持 `bun run src/cli.ts market source qualify --source hongguo --json` 和 `bun run src/cli.ts market source gaps --json`，另有采样计划（plan/show-plan）、采样回执（check-sample）、人工审查（review/review-receipt）与资格记录（record-qualification/qualification）owner 动作；资格与运行 health 分离，fixture/manual 不计入 live 天数，缺少采样计划/完整性证据时明确返回未合格。逐来源的持续资格验证（任务 5.4）仍需真实来源与权限，保持未完成。

目录文件导入已支持红果 HTML、ReelShort HTML、DramaBox Markdown 等明确链接结构，例如：

```bash
bun run src/cli.ts market import-catalog --source dramabox --file test/fixtures/market/dramabox.md --format markdown --observed-at 2026-09-11T08:00:00Z --fixture --json
```

该示例使用合成夹具；实际用户文件默认记 manual，并且必须提供原观测时间。当前只保留稳定作品 ID、标题、规范化公开链接，不推断热度、首发或地区。无可解析作品时报 unavailable，不把登录页当成功空目录；输入限制为2MB普通文件。

已有采集快照可用 `bun run src/cli.ts market import-legacy --run <legacy-run-ref> --json` 显式导入市场观测。该命令不重新采集，保留原 fetchedAt 和 snapshot 引用；因旧快照没有 fixture/live 来源标识，导入保守记为 manual，不能用来满足持续 live 资格。原始快照不修改。

从 Radar 子项目目录执行：

```bash
bun run src/cli.ts market init --json
bun run src/cli.ts market source list --json
bun run src/cli.ts market source show --source hongguo --json
bun run src/cli.ts market config show --json
bun run src/cli.ts market config set --revision 1 --timezone Asia/Shanghai --json
bun run src/cli.ts market source set --source hongguo --revision 1 --sampling-scope "Public catalog sample" --json
```

修改前先读取当前 revision，示例的1仅适用于初次初始化。init 不覆盖已有配置、不连接外部网站；18个来源初始都是planned，不代表平台已接通。结构校验与来源资格分开，不能通过source set直接标qualified。当前配置命令支持默认英文摘要、--json和--agent，不支持--events。后续observe/analyze/brief命令尚不可用。

实现真源：[proposal](../../openspec/changes/radar-market-observation-and-brief-v1/proposal.md)、[design](../../openspec/changes/radar-market-observation-and-brief-v1/design.md)、[tasks](../../openspec/changes/radar-market-observation-and-brief-v1/tasks.md)。跨项目治理归根 change，DSH 视觉方案归 harness-plugins。

## 数据长期化分层与在途变更（2026-09-16）

市场域数据当前全部落在本地 SQLite（热存储与证据真源）。数据长期化与变现按以下分层推进；L3 产品对外读取面与 L4 的 M2/M3 仍是方向判断，未承诺交付时间：

- L0 采集层：本地 SQLite 是热存储与证据真源，fixture/manual/live 区分已交付。
- L1 长期层：PostgreSQL 归档（已交付，见下文「L1 PG 归档同步」）。`radar market sync --to pg` 用 Drizzle 双方言把市场域数据幂等归档到用户提供的 PostgreSQL；SQLite 仍是真源，PG 是归档+分析副本。不新增服务端、不多用户、不开 remote endpoint。
- L2 入库层：candidate → canonical 正式入库门已交付（见下文「L2 正式入库门」）。质量指标入 `radar health`；`radar market canary report` 仍为 planned，落地时必须消费质量记录。
- L3 产品层：market brief / 跨市场对照 / signals 的只读投影，即面向读者的「榜单」。
- L4 变现层：M1 内部生产链（assignment → Auctra → Scaena）已通；M2 个人订阅简报，前提 5.5 十四天 canary 通过；M3 B 端数据 API，前提 5.4 来源资格、5.6 发布决定与未来 backend-server/radar-api 独立授权。三个真实门（5.4/5.5/5.6）未过前，M2/M3 不得标 ready。

对应三个 OpenSpec 变更（引用以 change id 为准）：

- [`radar-hongguo-catalog-parsing-v1`](../../openspec/changes/radar-hongguo-catalog-parsing-v1/)：红果目录解析清洗（标题/标签拆分、类目映射扩条目、字段覆盖率修复）；已交付。
- [`radar-market-pg-sync-v1`](../../openspec/changes/archive/2026-09-16-radar-market-pg-sync-v1/)：L1 的 PG 归档同步（已交付）。
- [`radar-work-ingestion-gate-v1`](../../openspec/changes/archive/2026-09-16-radar-work-ingestion-gate-v1/)：L2 的 candidate → canonical 入库门（已交付软件面）。

## L1 PG 归档同步（radar-market-pg-sync-v1，已交付）

`radar market sync --to pg` 把 12 张市场域证据表（sources/batches/observations/evidence/signals/work_mappings/briefs/reviews 及资格、采样、来源审阅回执）从 SQLite 真源幂等归档到用户提供的 PostgreSQL 独立 schema `radar_archive`：

```bash
radar market sync --to pg                                   # 增量续传；无游标时全量首同步
radar market sync --to pg --verify                          # 只读对账：行数 + 每表至多 100 行 digest 抽样，不一致退出码非零
radar market sync --to pg --chunk-size 500                  # 分块大小 1–5000，默认 500
radar market sync --to pg --reset-cursor --confirm-reset    # 显式清空游标后全量重放（幂等安全）
radar market sync --to pg --allow-target-change             # 确认更换目标实例（重新全量）
```

- 幂等与 append-only：写入按各表主键（幂等键）`ON CONFLICT DO NOTHING`；冲突行回查 `payload_digest`，一致记 reused，不一致报 `sync_conflict` 并中止该表、零改写，owner 审查后人工处置——归档行永不 UPDATE/DELETE。PG 镜像表只比 SQLite 多 `payload_digest` 与 `synced_at` 两列。
- 断点续传：SQLite 侧 `market_sync_state` 逐表存游标与 `target_fingerprint`（sha256(host|port|db|schema)，不含凭据），只在 PG 事务提交后推进；块间进程死亡重跑即从上一已提交块继续。游标损坏报 `cursor_invalid`，换目标报 `sync_target_changed`。
- 凭据来源与脱敏：连接串只来自 `RADAR_PG_URL` 或用户级 config 的 `pgArchive.url`（env 优先）；诊断与输出只含来源类型、脱敏 host/db/schema 与指纹前 12 位，DSN 一律 `<redacted>`；含 DSN 的 config 文件非 0600 时警告不阻止。
- 具名错误码：`pg_config_missing`、`pg_unavailable`、`pg_auth_failed`、`schema_mismatch`、`sync_target_changed`、`sync_conflict`、`cursor_invalid`、`sync_target_unsupported`（verify 不一致另报 `verify_diverged`），各附恢复命令。
- 个人阅读/关注状态、Profile/feedback、opportunities/editions、assignments、runs 与旧两平台管线表显式不出库。
- 调度边界：同步默认手动；`radar market schedule show/install` 只把 sync 列为可选挂接（owner 可在 market-brief 单元后自行追加 unit 的示例），不生成、不启用任何 sync 定时器，同步不在 cutoff/freeze 语义内。

真实 PG 集成回放（Testcontainers / `RADAR_TEST_PG_URL`）覆盖：首同步全量→重放零新增、杀进程后续传一致、篡改触发 `sync_conflict` 零改写、指纹门、损坏游标重放；证据在 `temp/integration-test-runs/`。

## L2 正式入库门（radar-work-ingestion-gate-v1，已交付软件面）

candidate 作品不会因 observe/import 自动变 canonical。owner 先评估再显式晋级：

```bash
radar market work gate show --json
radar market work gate report --source hongguo --json
radar market work review-batch --source hongguo --key <idempotency-key> --json
radar market work review-batch-receipt --key <idempotency-key> --json
radar market work promote --work <ref> --revision <n> --canonical <ref> --evidence <ref> --json
radar market work promote --work <ref> --revision <n> --canonical <ref> --evidence <ref> --override-reason "<text>" --json
radar health 14 --json
```

- 四条版本化规则（`work-ingestion-gate-rules.v2` / `catalog-fields.v2`）：跨批次身份印证、别名无冲突、必需字段覆盖（title/category/episode_count）、至少一条非 fixture 证据。旧 `v1` 决定不追溯重判。
- 批量 review 只记不可变 gate decision，不晋级；同键同参重放零新决定，同键异参 `idempotency_conflict`。
- promote 要求现行版本下针对 head revision 的 operative 决定为 promotable；否则 `gate_not_passed` / `stale_gate_decision`。`--override-reason` 同事务留下 overridden 审计决定。既有 `work review` 语义不变，作为回退入口。
- observe / import-catalog 与批次同事务写 `radar.observation_quality.v1`；`radar health` 增加市场质量段，覆盖率下降超 10 个百分点标 `regression_flagged`（告警，不是失败门）。历史无记录批次显式 `quality_unavailable`，不回填。
- `radar market canary report` 仍以 `capability_unavailable` 拒绝；落地时必须消费质量记录。入库门不改变来源 readiness，不自动晋级。

已知限制（2026-09-16 验证）：红果 live 验证采样已抓到 24 部作品，origin=live，但 readiness 仍 planned，全部作品 mapping_status=candidate。当批样本标题存在「标题重复两遍+标签串」粘连、category 字段覆盖 0/24；解析清洗已由 `radar-hongguo-catalog-parsing-v1` 交付（`hongguo-anchor-layout.v1` 拆分 anchor 卡片结构、标签经 `market-label-mapping.v1` zh 表消费、跳过归因入回执 limitations），脱敏夹具回放 category 覆盖 6/7（唯一缺口为结构性无标签的纯文本 anchor），同页真实结构离线回放达 24/24。存量 24 部作品的旧 live 观测与证据不可变、仍带粘连标题，不可作为 canonical 数据消费。2026-09-18 owner 显式 `--confirm-live` 重采样已生成新 batch：标题全部无粘连、category 与 episode_count 覆盖 24/24、每作品 mapping 新增 revision 且旧证据逐字节未改写（change radar-hongguo-catalog-parsing-v1 任务 4.2）；readiness 仍 planned、作品仍 candidate，类目观察覆盖仍不可据此宣称完成。

## 使用体验

第一次使用不要求先填写创作偏好；有真实已完成数据就可读，没有则显示尚未建立观察窗口及 owner 配置步骤。默认摘要最多 5 条重要变化、2 条待观察；不按数量凑新闻。

每条先回答：变了什么、与何时比较、为什么这样判断、哪些部分尚不能断言。详情提供代表作品、原始来源安全引用、时间线、指标口径、跨市场对照与更正历史。语义必须区别“新观察到”“来源标注的新作”“新未读修订”。

用户已接受的五项扩展全部在范围内：

1. 阅读补看：按显式已读的信号修订整理变化，几天未读也不重复铺满旧闻。
2. 自选观察：题材、作品、平台、地区可关注、暂停、恢复、取消；不改变市场事实。
3. 跨市场对照：同题材或已核实同作分别展示地区、窗口与指标，不生成全球热度总分。
4. 周度判断回顾：保留原判断，说明后来持续、消退、更正还是无法判断。
5. 证据问答：对“是不是多采了一个来源”“有没有反例”等问题给出有出处的回答，无据则明确未知。

阅读默认中文；外文作品保留原名和翻译，不因译名相近直接合并。禁区一致执行，普通 personal_fit 不屏蔽市场全局变化。

## 主动市场与平台矩阵

本表是观察组合建议，不是市场份额排名。P0 表示优先资格化，不表示已接入；地域是目标采样范围，不是已经证实的实际受众地区。各平台/地区均须取得自己的字段和可比性证据。

| 地区／场景 | 候选平台 | 优先级 | 主要观测 | 已核实与缺口 |
|---|---|---|---|---|
| 国内真人作品 | 红果短剧 | P0 | 作品目录、题材、集数、展示变化 | 开发者官网一次读取可见上述内容；live 验证采样已通（origin=live），解析清洗已在 2026-09-18 真实重采样验证（标题无粘连、category 24/24），连续性/完整榜单/热度待验证 |
| 国内漫剧 | 红果漫剧、火龙漫剧 | P0 | 漫剧作品、上新、形式 | 官方商店介绍可核对身份与产品功能；作品采样和 AI 制作标签待验证 |
| 国内补充样本 | 快手、喜番短剧 | P1 | 作品供给与差异样本 | 喜番身份可核对；本次未完成快手作品级入口资格验证 |
| 国内传播/讨论 | 抖音、小红书、B站 | P1 | 关联作品的传播与评论样本 | 前两者已有 Radar 适配器；实际 live 健康需另查；B站待资格化 |
| 北美，以美国为初始样本 | ReelShort、DramaBox | P0 | 作品、题材和目录变化 | 官网作品页可读；全球英语网页不能直接代表美国受众 |
| 拉美，以墨西哥/巴西为样本 | DramaBox、NetShort、当地语言来源 | P1 | 西语/葡语目录与地区信号 | 产品身份可核对；语言、地区数据资格和稳定窗口尚缺 |
| 东南亚，以印尼为样本，泰国/菲律宾后续深化 | Melolo、DramaWave、PineDrama | P1 | 区域平台作品与形式 | 官方商店身份可核对；DramaWave 官网本次提取失败，作品数据待验证 |
| 印度 | Kuku TV、QuickTV | P1 | 区域作品、语言和题材 | 印度商店可核对身份；作品级数据待验证，不能拿商店可用性当热度 |
| 日本/韩国/西欧及新平台 | 主动定期扫描并生成候选资格记录 | exploratory | 新来源及地区缺口 | 不宣称覆盖所有市场；没有合格源时显示覆盖未知 |
| 行业背景 | DataEye、Sensor Tower 等 | optional provider | 平台、广告和行业报告 | 用作背景/商业补缺候选，不把 App 收入等同作品收入 |

核心组合同时包含作品消费平台、传播平台和行业资料。不能把同一内容集团、同一榜单的转载计为独立印证。红果短剧与红果漫剧可提供不同消费场景，但不因两入口就多计一次独立市场证据。

每个候选来源登记：身份链接、publisher group、地区/语言、可用字段、采样范围、更新频率、授权方式、付费依赖、失败原因、替代输入和 readiness。来源发现不要求用户列平台名单；只在需要账号、采购或其他外部权限时提出具体决定。

## 本次调研证据

以下均于 2026-09-11 读取/核对；属于方案来源，未保存为产品采集回执，也未通过连续资格验证。后续资格任务须重新采样并保存脱敏证据。

| 来源 | 证据支持 | 不支持 |
|---|---|---|
| [红果官方商店](https://apps.apple.com/cn/app/id6451407032) 与其 [开发者官网](https://novelquickapp.com/hongguo) | 产品身份、官网链接、公开作品/分类/集数 | 全量作品、真实播放、稳定 API、连续趋势 |
| [红果漫剧](https://apps.apple.com/cn/app/id6745890963) | 独立漫剧消费场景及介绍中的热榜 | 每部作品皆 AI 制作、可稳定抓取 App 榜单 |
| [火龙漫剧](https://apps.apple.com/cn/app/id6756595533) | 腾讯发布的漫剧 App；介绍含上新日历和榜单 | 作品热度、榜单自动接入能力 |
| [喜番短剧](https://apps.apple.com/cn/app/id6744434275) | 短剧产品及内容介绍 | 当前市场份额或自动数据出口 |
| [ReelShort](https://www.reelshort.com/) 与 [DramaBox](https://www.dramabox.com/) | 公共作品链接、简介和分类 | 推荐位等于真实热度、全球页等于国家榜单 |
| [NetShort](https://apps.apple.com/us/app/id6504849169) | 产品身份及开发者网站 | 地区级作品表现 |
| [DramaWave](https://apps.apple.com/us/app/id6670430706) | 产品和开发者网站身份 | 官网本次不可提取，不能证明作品采集可用 |
| [Melolo](https://apps.apple.com/id/app/id6737513497) 与 [PineDrama](https://apps.apple.com/id/app/id6754134922) | 印尼商店产品身份及短剧定位 | 印尼用户热度/下载份额 |
| [Kuku TV](https://apps.apple.com/in/app/id6737497276) 与 [QuickTV](https://apps.apple.com/in/app/id6747964677) | 印度商店产品身份与短剧内容定位 | 印度全市场样本覆盖 |
| [DataEye](https://www.dataeye.com/) | 官方描述国内外短剧情报、素材、榜单和行业数据 | 未验证订阅价格、API 权限或当前用户访问能力 |
| [Sensor Tower 2025 报告](https://sensortower.com/blog/state-of-short-drama-apps-2025) | 2025 地区结构参考及 IAP 估算口径说明 | 2026 当前份额、作品收入或完整短剧市场收入 |

避免把搜索结果中自称官网的域名直接加入信任列表；从开发者/平台主体链接交叉核对。引用是核对依据，不是执行网页指令的授权。

## 场景矩阵与验证入口

目标用户统一为当前单人市场观察者；表中额外标明具体使用角色。所有新场景当前为 exploratory，软件和真实证据齐备后再分别晋级 first-support/mature。

以下文件名是场景验收目标，部分已落地，部分仍待实现；实际测试位置与运行证据以 tasks.md 进展和仓库文件为准，不能将表中目标名称当成已经通过的测试。集成流程统一由 bun run test:integration 保存证据。证据路径均为本项目 temp/integration-test-runs/<run-id>/artifacts/；不手写报告。

| ID | 用户／job | 必需产物 | gate／review | 验证文件或流程 | 证据／handoff |
|---|---|---|---|---|---|
| S01 | 国内读者发现红果作品 | source qualification、observation | 身份、采样范围 | market-sources.test.ts | 来源证据→coverage |
| S02 | 海外读者辨认地区 | 带地区依据的 observation | global/unknown 不强配国家 | market-observations.test.ts | 地区证据→安全投影 |
| S03 | 读者遇到断源仍能阅读 | partial brief、错误回执 | 有界重试、风控停止 | market-observe.integration.test.ts（集成） | run→brief |
| S04 | 操作者导入/重放样本 | 幂等 batch receipt | 原子性、fixture/manual/live 区分 | market-observations.test.ts | receipt→owner 查询 |
| S05 | 漫剧观察者区分 AI | 形式与制作方式标签 | unknown 不猜测 | market-classification.test.ts | 标签证据→DSH 筛选 |
| S06 | 读者看到新作品 | observed signal | 历史不足不称趋势 | market-comparison.test.ts | signal→brief |
| S07 | 读者判断真假升降 | comparison receipt | 采样/指标/时窗漂移 | market-comparison.test.ts | 比较依据→detail |
| S08 | 跨语读者识别同作 | candidate/verified mapping | 译名不能自动合并 | market-identity.test.ts | 映射证据→compare |
| S09 | 读者识别转载 | source lineage | 非独立印证去重 | market-signals.test.ts | 信号证据→question |
| S10 | 晨报读者三分钟快读 | 有界 brief | 不凑数、无重大变化诚实空报 | market-briefs.test.ts | brief→Agent/DSH |
| S11 | 读者遇到生成失败/迟到 | 最近成功 brief、新修订 | 原子冻结、时区/DST | market-pipeline.integration.test.ts（集成） | runs→恢复 |
| S12 | 三天未读者补看 | revision-based unread | Agent 预读不记已读 | market-reader.test.ts | reader→catch-up |
| S13 | 两入口用户并发操作 | reader revision、receipt | 冲突/同键异参/未知对账 | market-reader.test.ts | receipt→DSH reconcile |
| S14 | 设置禁区的读者 | policy-filtered projection | 历史/搜索/问答不绕过 | market-policy.test.ts | policy→全部出口 |
| S15 | 跨市场比较者 | comparison projection | 不同口径不共轴、不推因果 | market-cross-market.test.ts | compare→DSH |
| S16 | 每周回顾者 | weekly review | 缺后续是 inconclusive | market-review.test.ts | review→Agent/DSH |
| S17 | 追问依据的读者 | question context | 引用有效、拒绝无据断言 | market-question.test.ts | safe context→当前 Agent |
| S18 | 无本机 CLI 的 Agent | MCP resources/actions | discovery/lane/receipt | market-mcp.integration.test.ts（集成） | MCP→consumer |
| S19 | 原个人推荐用户 | 原 card/Profile/Edition | 原合同 golden 和旧行为 | 既有测试＋market-compat.test.ts | 原接口继续可用 |
| S20 | 试用者与产品负责人 | 14 天真实报告、来源缺口 | 缺源/失败日纳入分母 | 真实试用任务 R5 | 脱敏报告→付费缺口决定 |

## 交付批次与衡量

R1 来源及观测 → R2 可比信号与每日简报 → R3 阅读/关注/对照/回顾 → R4 CLI/MCP/问答证据 → R5 软件及真实验证。DSH 可用离线合同夹具先设计，但不能声称已经消费真实数据。全部五项扩展保留，不以首批完成消除后续任务。

新市场试用报告衡量按时可读、覆盖缺口、阅读耗时、重要变化漏报、无变化旧闻重复、查证成本及更正；打开次数、收藏数只是辅助。首个 14 天窗口至少 10 天可审查，其余指标先收集可信基线再决定阈值。对照使用预先固定的来源样本，不要求用户先列出平台，不宣称计算全市场召回率。

当前可运行的仓库检查：

```bash
bun run typecheck
bun test
bun run test:integration
openspec validate radar-market-observation-and-brief-v1 --strict --no-interactive
```

2026-09-13 软件最终门已通过：typecheck、全量 bun test、bun run test:integration（带证据）与 strict openspec validate 全部退出 0，具体结果及证据位于 change 的 tasks.md。真实 14 天试用与已授权来源资格仍属外部门，未由本页推断完成。

本地回顾支持 `radar market review build --start <UTC时间> --end <UTC时间> --as-of <UTC截止时间>` 和 `radar market review show --review <回顾引用>`。回顾冻结原始与后续信号版本，缺少后续证据表示证据不足；读取旧回顾继续执行当前禁区。不指定窗口时，`radar market brief build` 采用配置时区的上一完整日，`radar market review build` 采用上一完整周（周一到周一），回顾截止默认为当前时间。日历计算覆盖夏令时的 23/25 小时日；不存在的本地日期明确报错，不按固定 24 小时猜测。自动定时触发以 market schedule install 生成的 systemd 单元为准（写入不启用，启用为 owner 动作）；本容器等无 systemd 环境只输出安装说明，不报告已调度。MCP operator 的构建参数仍要求显式窗口，以当前 tools/list 为准。

本地跨市场对照支持 `radar market compare --left <信号引用> --left-revision <版本> --right <信号引用> --right-revision <版本>`。两侧保留各自原名、地区依据、采样范围、时间及指标口径，不合成跨平台热度。候选同作映射只表示待核实，任一侧触发当前禁区时整个请求拒绝。当前已验证目录夹具与安全读取，并暴露 MCP 读取入口；已验证同作的评审流程和 DSH 展示仍待接入。

### MCP 市场读取入口

来源审查通过 owner CLI `radar market source review --source <ref> --revision <n> --stage <identity|sample|blocked> --reason <理由> --key <key>`；identity/sample 需提供 `--evidence <ref>`，sample 还需 `--batch <ref>`。证据必须已存、同源、非 fixture 且不晚于审查时间；样本晋级要求身份已通过、当前版本非空样本及完整 ID/口径检查和失败样本引用。操作者负责判断证据内容是否真正证明身份或失败处理，引用存在本身不能证明事实。审查追加来源版本、保留原记录；`radar market source review-receipt --key <key>` 支持原键对账。新版本需重新登记采样计划。正式 qualified 状态晋级仍待实现，以上审查不触发外部采集，不开放 MCP 写入。

资格报告可由 owner 使用 `radar market source record-qualification --source hongguo --revision 1` 冻结，实际 revision 以来源查询为准。`radar market source qualification --record <ref>`、MCP `market_qualification` view 或 `radar://market/qualifications/{ref}` 读取同一不可变记录。记录包括判定规则版本、来源版本、截止时间、窗口和缺口，不自动修改 readiness；来源后续更新不会覆盖旧记录。人工样本审查与正式状态晋级仍需完成。

来源资格报告已检查采样质量回执：七个完整 UTC 日须有共同固定时点、完整样本及稳定 ID/口径检查，并满足身份和样本审查前置。操作者在 owner host 使用 `radar market source check-sample` 记录批次检查，参数见 CLI help；记录不改变原观测的 fixture/manual/live 类型，资格读取也不自动升级来源 readiness。当前正例来自合成数据库测试，不能据此声称任何真实平台已覆盖七天。人工样本审查入口与资格决定持久化仍待完成。

采样前先运行 `radar market source plan --source hongguo --revision 1 --slot 00:00 --slot 12:00`（revision 使用实际来源版本），通过 `radar market source show-plan --source hongguo --revision 1` 查询。时点为 UTC，首版至少两次且跨度至少12小时；计划绑定来源版本与采样范围，不能原地修改。资格窗口开始前必须已登记，七天内计划的每个时点均需完整质量回执；事后登记不追认历史，修改计划须创建新来源版本并重新积累窗口。登记计划不会自动启动抓取或后台任务。

关注清单及历史回执按当前禁区重新投影。被禁止题材或当前分类未知/受限的作品不会出现在清单中；按旧 key 查询或重放也返回 `content_blocked`，不复述目标内容、不新增回执或推进阅读版本。底层历史保持不变，解除禁区后可再次读取原记录。

显式撤回或证据不足更正后，自动分析不会恢复原判断；旧观测重放与同一信号的新指标输入返回 `correction_review_required`。观测继续保存，不能把跳过该信号解释为市场没有新变化。操作者可在 owner host 使用 `radar market signal restore --signal <引用> --revision <更正版本> --observation <新观测引用> --reason <理由> --at <UTC审查时间>` 明确重新审查。新观测须晚于更正、早于或等于审查时间，属于同一来源、作品、市场和数据真实性类别；指标必须仍满足原可比口径。恢复追加修订、保留旧更正并重新进入未读；相同审查重放返回原修订，陈旧或同版本不同审查拒绝。该 owner 审查操作不自动向 MCP 开放。

市场只读投影现已接入既有 `radar.search`，仍保持 `radar.search` / `radar.execute` 两个工具名称。已连接客户端先读取 `tools/list`，按 inputSchema 中对应 view 分支提供参数；无需本机安装 Radar，也不访问 owner 的 SQLite 或文件路径。

| 读取目标 | view / resource |
|---|---|
| 能力与恢复位置 | `radar://market/capabilities` |
| 来源与覆盖缺口 | `market_sources`、`market_coverage`；`radar://market/sources`、`radar://market/coverage` |
| 最新/指定简报 | `market_brief`；`radar://market/briefs/latest`、`radar://market/briefs/{ref}` |
| 历史信号 | `market_signal`（signal、revision 必填）；`radar://market/signals/{ref}/revisions/{revision}` |
| 阅读、补看、关注 | `market_reader`、`market_catchup`、`market_watches` |
| 原键对账 | `market_reader_receipt`、`market_watch_receipt`；`radar://market/reader/receipts/{key}`、`radar://market/watch/receipts/{key}` |
| 回顾与对照 | `market_review`、`market_compare`；`radar://market/reviews/{ref}` |
| 证据与问答上下文 | `market_evidence`、`market_question`；`radar://market/signals/{ref}/revisions/{revision}/evidence/{evidence}` |

`radar_market_brief` prompt 引导先读覆盖缺口，再读已存简报和明确修订的证据，区分事实、推断与未知。读取不触发采集、模型调用或已读写入。需要配置或补采时，由操作者在 **Radar owner host** 执行对应 CLI，不能要求未安装 CLI 的消费端执行本地命令。DSH 的真实接入仍待完成。

显式写入通过 `radar.execute`，可用动作及完整 inputSchema 随连接 lane 返回：

| lane | 市场动作 | 输入与恢复 |
|---|---|---|
| reader | 无写入动作 | 尝试写入返回 action_denied，不提升权限 |
| curator | market_reader_mark / market_reader_unread | key、revision、policy_revision、signals（1–100 个明确 ref/revision）；只提交用户选中的修订 |
| curator | market_watch_add / pause / resume / remove | key、revision、policy_revision，加 kind/target 或 watch；保留暂停与取消状态 |
| operator | 继承 curator，加 market_analyze / market_brief_build / market_review_build | start/end，回顾另需 as_of；只处理已存本地观测，不触发采集 |

读者与关注动作共用 reader revision；先读 `radar://market/reader`，再显式操作。同键同参返回原回执，同键异参为 idempotency_conflict，陈旧 reader/policy 为 state_conflict。断线导致结果未知时先查询原 key 的 receipt，不换 key 重试；确认未提交且重读当前状态后才能发起新动作。capabilities 中的 mutations/actions 反映当前连接权限。来源、配置、Profile、qualification 与 observe 均不进入市场可执行 discovery。
