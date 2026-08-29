# Short-Drama Radar 子项目说明

本目录是 `short-drama-radar` TypeScript/Bun CLI 子项目，独立 git submodule，默认分支 `develop`。它拥有短剧领域情报数据：四层采集（公共页 → 平台后端 CLI → 受控浏览器 → 人工兜底）、SQLite 快照、标准化去重、标签/评分 v0、人工质检门和 `short-drama-radar.card.v1` 卡片合同。云婉（外部项目）拥有通用调度、去重投递和飞书发送；短剧业务逻辑不得塞入云婉。

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

- 拥有：短剧候选发现、快照历史、跨平台标准化、钩子/题材/情绪标签、v0 评分、`confidence`、卡片合同 payload、运行证据。
- 不拥有：剧本生成、投放管理、多人协作后台、飞书投递实现、通用采集调度（云婉）。
- 抖音官方开放平台不覆盖全平台热榜，不能作为主源；小红书“传播增速”用互动增量作代理值，禁止伪造播放量。

## 禁止事项

- 不在 stdout/stderr/日志/证据/fixture 中保存 cookie、token、Authorization 头、代理密码或模型完整推理。
- 不静默用旧数据出卡；缺数据必须显式 `degraded` 标记。
- 不自动绕过验证码与平台风控；账号池耗尽即降级+告警。
- 不绕过 Drizzle 写裸 SQL 做业务读写。

## 测试与验证

```bash
bun test                      # unit + integration（夹具驱动，默认不碰真实平台）
bun run typecheck
bun run test:integration      # 带证据：temp/integration-test-runs/<run-id>/
RADAR_FIXTURE_DIR=test/fixtures bun run src/cli.ts run --json   # 离线端到端冒烟
```

集成/组件/系统/e2e 测试必须通过 `scripts/integration-test-run.ts` 写入 `summary.json`、`command.txt`、`stdout.log`、`stderr.log`、`env.json`、`artifacts/`，脱敏后保留失败证据并以原退出码退出。

## 14 天验证

按根计划执行：D1–2 采集主路就绪（每平台每天 ≥30 候选）；D3–5 快照/去重（稳定 ID ≥90%，重复率 ≤5%）；D6–9 影子运行（连续 4 天 9:00 前送达，Top10 人工合理率 ≥80%，降级天数 >30% 触发停止评审）；D10–14 10 名目标用户收费验证（≥2 人实付 79 元）。
