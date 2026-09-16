# short-drama-radar

新增本地决策闭环：`radar decision help`。通过 CLI 管理候选证据、显式基线、实验锁定、小样哈希绑定、取消、准备检查、本地工作包导出和人工结果回顾；见[完整操作指南](docs/product/greenlight-pilot/cli-guide.md)。该能力不自动采集、生成或招募，fixture 与真实观测保持区别。

[国内外市场变化 Radar](docs/product/global-market-radar.md)的本地软件面已按 OpenSpec 交付：来源/观测/资格存储与 CLI、可比信号与更正、每日简报、补看/已读/关注、跨市场对照、周度回顾、question context 与文件回执；读取性能在 100k 观测夹具下 p95<100ms。红果公共目录现已支持显式 live 验证采样：`radar market observe --source hongguo --mode verify-sample --confirm-live`。生产 observe 仍要求 `sample_verified` 或 `qualified`。`radar assignment create` 把个人 Edition 变成不可变生产任务；`radar assignment submit --auctra-path <project>` 调用 Auctra `text proposal from-radar`，成功后才写 `used`。Auctra accept 之后 `radar assignment produce --scaena-path <project>` 建 Scaena 骨架，不分镜、不生成。其余来源资格、14 天试用与发布/付费决定仍是独立外部门。

数据长期化方向：市场域数据以本地 SQLite 为热存储与证据真源。三个接续 OpenSpec 变更均已交付软件面：`radar-hongguo-catalog-parsing-v1`（红果目录解析清洗）、`radar-market-pg-sync-v1`（`radar market sync --to pg` 幂等、断点续传归档到用户提供的 PostgreSQL，PG 是归档+分析副本，append-only 不改写，连接串只来自 `RADAR_PG_URL` 或用户级 config 且全链路脱敏，不新增服务端）、`radar-work-ingestion-gate-v1`（candidate → canonical 入库门：`radar market work gate/review-batch/promote`，观测质量写入 health；`radar market canary report` 仍为 planned）。L0–L4 分层与变现前提详见 [docs/product/global-market-radar.md](docs/product/global-market-radar.md)。

短剧爆款雷达：爬虫主路的每日短剧选题情报 + 个人化机会 Edition CLI。每天从抖音/小红书四层采集候选内容，快照入库、去重、打标签、评分，输出 Top5+Top5 卡片合同 payload 与只属于当前创作者的 Morning Edition。

## 快速开始

```bash
bun install
bun run src/cli.ts doctor            # firecrawl / agent-reach / cookie env / playwright / schedule
bun run src/cli.ts run --json        # collect -> score -> cluster -> card + edition
```

离线冒烟（不碰真实平台）：

```bash
RADAR_FIXTURE_DIR=test/fixtures bun run src/cli.ts run --json
```

## 采集分层

1. Layer 0：自托管 Firecrawl 抓公共热榜/发现页（免登录，基线覆盖）。
2. Layer 1：仅使用 CLI 的小红书后端（OpenCLI 或 xhs-cli）+ 抖音签名 API 层（原生 X-Bogus signer，登录 cookie 经 `DOUYIN_COOKIE` 用户环境注入，永不落盘）。
3. Layer 2：Playwright 受控浏览器兜底，账号池 LRU 轮换 + 每日配额 + 验证码 24h 熔断（不自动绕过）。
4. Layer 3：人工截图/CSV 导入。

规则：不自动绕过验证码与风控；账号池耗尽即降级并在结果中明示。Layer 2 账号描述符在 `~/.short-drama-radar/accounts.json`（仅 opaque 引用，凭据只在用户 secret store）。

## 输出合同

- `radar card`：`short-drama-radar.card.v1`（冻结兼容合同，golden 测试锁定）。
- `radar edition build|show`：`radar.morning_edition.v1` 不可变个人版次（绑定 profile revision + ranker version + evidence digest）。

### 标准 envelope（迁移说明）

所有 `--json` 输出使用仓库标准 envelope（`spec_version=1.0`，顶层仅
`spec_version/mode/command/status/summary/facts/actions/evidence/confidence/data/error`）。
私有 `0.0.x` 草案 `{ok, app, command, data, errors}` 已在
`personalized-radar-agent-experience-v1`（task 1.4）一次迁移废弃：fixture
`test/fixtures/envelope-legacy-0.0.1.json` 仅作迁移证据保留，不提供
`--legacy-output`。首个公开版本只发布标准 envelope。

四种输出模式：默认英文 summary（含一个 next command）、`--json`（envelope）、
`--agent`（单行 key=value）、`--events`（collect/run 的 NDJSON 进度流）。

## 个人化

```bash
radar profile create --name main --topic revenge:90 --hook face_slap:70 --blocked-topic taboo_ethics
radar profile set --risk-tolerance 60
radar feedback add --opportunity <ref> --kind saved|used|dismissed|not_relevant|too_risky|already_seen
radar edition build --limit 8
radar edition show latest
```

Profile 更新只创建不可变 revision；反馈 append-only、幂等、每特征 [-15,+15]
有界修正；blocked topics 硬过滤优先于一切正向反馈；空榜是诚实结果并给出真实原因。

## CLI 交互与回执

```bash
radar doctor
radar runs --json
radar run --json
radar market observe --source hongguo --mode verify-sample --confirm-live --json
radar assignment create --json
radar assignment submit --auctra-path <auctra-project> --json
radar assignment produce --scaena-path <scaena-project> --json
radar market brief show --json
```

Radar 只提供 CLI；结果和运行回执保存在用户级目录。小红书只允许 CLI 后端。

## 调度与健康

```bash
radar schedule show --json
radar schedule install [--backend auto|systemd|launchd|windows] [--print]
radar schedule session-plan --runtime both --json
radar health 14                    # source coverage / stable id / duplicate rate / degraded days
radar canary report 14 --json      # Edition days / usefulness / false-or-unexplained gates
```

OS 单元默认不启用。macOS 用 launchd，Windows 用 Task Scheduler，Linux 仍是 systemd user timer。无 OS 调度器时用 session-plan 做只读巡检，不能代替 08:10 collect。详见 [docs/runtime/schedule.md](docs/runtime/schedule.md)。

## 测试

```bash
bun test
bun run test:integration
bun run typecheck
```

规则与边界详见 [AGENTS.md](./AGENTS.md)；产品与接口文档见 [docs/](./docs/README.md)。
