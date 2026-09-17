# Short-Drama Radar 子项目说明

## 当前阶段（2026-09-17 用户调整）

聚焦中国大陆、香港、台湾、日本、韩国与欧美的个人自用，具体国家／语言保持可追溯；不招募受众，不把访谈、供应商询价、独立研究者或 A/B 实验作为使用前置条件。优先已有来源、简报、收藏、关注、补看和个人回顾。当前计划见 `docs/product/personal-radar.md`；旧实验方案保留参考，不据此恢复招募。原有来源资格、数据真实性及历史反馈语义不变，十四天 canary 是个人持续质量回顾，不是开始使用的等待门。

本目录是 `short-drama-radar` TypeScript/Bun CLI 子项目，独立 git submodule，默认分支 `develop`。它拥有单人优先的短剧机会情报：四层采集（公共页 → 平台后端 CLI → 受控浏览器 → 人工兜底）、SQLite 快照、标准化去重、基础标签/评分、个人 Profile/revision、append-only 反馈、机会簇、个人排序、Morning Edition、运行证据和 `short-drama-radar.card.v1` 兼容合同。外部 Agent/客户端只消费稳定 CLI/MCP/API 投影，不得接管领域真源。

## 工作语言

产品、设计、OpenSpec 和实现文档默认中文；CLI help/output、日志、错误、`--json` 信封、schema 字段、命令名、代码注释默认英文。

## 技术栈

- 语言/运行时：TypeScript on Bun（1.3+），纯子项目 CLI，无服务端。
- 持久化：Drizzle ORM over `bun:sqlite`，库文件默认 `~/.short-drama-radar/radar.db`；业务读写必须走 Drizzle，DDL 只允许集中在 `src/db/client.ts` 的 `migrate()`。
- 采集分层：
  - Layer 0：自托管 Firecrawl（`/v1/scrape`），公共页免登录，基线覆盖率。
  - Layer 1：agent-reach 选择的小红书后端（OpenCLI / xhs-cli / xiaohongshu-mcp）+ 抖音自研签名调用层（未实现前必须降级，禁止伪造数据）。
  - Layer 2：本项目维护的 Playwright flows，账号↔代理固定配对，验证码/风控熔断 24h，不做打码或滑块自动破解。
  - Layer 3：人工截图/CSV 导入，快照标记 `degraded`。
- 凭据：cookie、代理密码只进用户级 secret store / agent-reach 用户配置，绝不入库、入仓、入日志、入证据。

## 架构边界

- 拥有：短剧候选发现、快照历史、跨平台标准化、钩子/题材/情绪标签、基础 market score/`confidence`、个人 Profile/revision、反馈 ledger、机会簇、personal fit、Morning Edition、卡片合同 payload、MCP 安全投影、运行/审计证据，以及墙钟调度单元（Linux systemd / macOS launchd / Windows Task Scheduler）和 Claude/Grok session-plan 投影。不实现 Claude/Grok 调度器本身。
- 不拥有：剧本/分镜/图片/音频/视频生成、投放管理、多人协作后台、云同步、远程 Agent 服务、Workbench/DSH UI、飞书投递实现、通用跨项目调度。
- Hermes、Workbench 与 DSH 是 consumer：不得读取 Radar SQLite、用户配置或审计文件，不得保存第二份 Profile/排序/Edition 真源，不得自动批准 production mutation。
- 抖音官方开放平台不覆盖全平台热榜，不能作为主源；小红书“传播增速”用互动增量作代理值，禁止伪造播放量。

## 禁止事项

- 不在 stdout/stderr/日志/证据/fixture 中保存 cookie、token、Authorization 头、代理密码或模型完整推理。
- 不静默用旧数据出卡；缺数据必须显式 `degraded` 标记。
- 不自动绕过验证码与平台风控；账号池耗尽即降级+告警。
- 不绕过 Drizzle 写裸 SQL 做业务读写。
- 不让 MCP/Profile suggestion、Hermes memory 或客户端 cache 直接覆盖 Profile 真源；Profile mutation 只走 Radar CLI/application service。
- 不在未完成 canary 前把 remote endpoint、A2A、公共 Hermes Skill 或多用户能力标为 ready。

## 测试与验证

```bash
bun test                      # unit + integration（夹具驱动，默认不碰真实平台）
bun run typecheck
bun run test:integration      # 带证据：temp/integration-test-runs/<run-id>/
RADAR_FIXTURE_DIR=test/fixtures bun run src/cli.ts run --json   # 离线端到端冒烟
```

集成/组件/系统/e2e 测试必须通过 `scripts/integration-test-run.ts` 写入 `summary.json`、`command.txt`、`stdout.log`、`stderr.log`、`env.json`、`artifacts/`，脱敏后保留失败证据并以原退出码退出。

## 14 天验证

首轮只做单人 canary：D1–3 完成 Profile 与采集/证据基线；D4–7 验证机会聚类、个人排序、空榜和降级；D8–14 连续生成 Morning Edition 并记录 `saved|dismissed|used|not_relevant|too_risky|already_seen`。通过门：至少 10 天有可审查 Edition，非空 Edition 中 ≥60% 至少一个 `saved|used`，明显误报/不可解释项 ≤25%，反馈只改变未来 Edition，且无秘密泄露、跨 Profile 污染或断线自动重复采集。通过后再用 5–8 个隔离 Profile/用户样本验证差异，不把收费或团队化作为首轮完成条件。

## 单次输入页面例外

用户批准的 `mcp-input-intake-experience-v1` 允许显式启用、仅绑定一个输入请求的同源上传页；不扩展为首页、资产库或后台。文件和权限仍由本项目服务持有，上传不自动批准生成、覆盖、分析或付费。新增入口默认关闭。
