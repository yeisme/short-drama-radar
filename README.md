# short-drama-radar

[国内外市场变化 Radar](docs/product/global-market-radar.md)的本地软件面已按 OpenSpec 交付：来源/观测/资格存储与 CLI、可比信号与更正、每日简报、补看/已读/关注、跨市场对照、周度回顾、question context、MCP 只读/curator/operator 面与 handoff 向量；读取性能在 100k 观测夹具下 p95<100ms。真实来源资格、14 天试用与发布/付费决定仍是独立外部门（来源初始为 planned，不代表已接通真实平台）。

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
2. Layer 1：agent-reach 小红书后端（OpenCLI / xiaohongshu-mcp / xhs-cli，按 `agent-reach doctor` 路由）+ 抖音签名 API 层（原生 X-Bogus signer，登录 cookie 经 `DOUYIN_COOKIE` 用户环境注入，永不落盘）。
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

## MCP（stdio，三 lane）

```bash
radar mcp --transport stdio --lane reader     # 只读（Hermes 默认）
radar mcp --transport stdio --lane curator    # + feedback/review 写入
radar mcp --transport stdio --lane operator   # + score/cluster/edition（collect/daily_run 为 CLI-only）
radar mcp doctor                              # backing 真实探测
radar mcp capabilities                        # ready|planned|blocked|unavailable
radar audit tail                              # radar.mcp.audit.v1 唯一读口
```

Profile mutation 永不进入 MCP；collect/daily_run 声明外部平台副作用，由 host
确认策略把关；断线按 run/edition receipt 对账，不自动重放。

## 调度与健康

```bash
radar schedule install [--print]   # systemd user XHS service + 08:10/08:30 collect、08:42 score、08:55/08:59 card
radar health 14                    # source coverage / stable id / duplicate rate / degraded days
radar canary report 14 --json      # Edition days / usefulness / false-or-unexplained gates
```

## 测试

```bash
bun test
bun run test:integration
bun run typecheck
```

规则与边界详见 [AGENTS.md](./AGENTS.md)；产品与接口文档见 [docs/](./docs/README.md)。
