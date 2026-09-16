# short-drama-radar docs

本子项目的产品、设计、运行时与实施文档目录（子项目文档归属规则：root 不重复保存）。

本地 [`radar decision` 操作指南](product/greenlight-pilot/cli-guide.md)提供决策包、证据／候选、基线、实验锁定、结果更正、取消、小样版本绑定、准备检查、本地工作包导出和回顾的完整 CLI 演练。软件状态与真实受众验证分别报告。

2026-09-16 首轮[漫剧立项决策包](product/greenlight-pilot/decision-pack.md)已完成公开资料研究，包含[13 个地区初筛与三市场深查](product/greenlight-pilot/market-research.md)、[小样实验设计与预算示例](product/greenlight-pilot/experiment-design.md)及[来源与原始基线说明](product/greenlight-pilot/research-notes.md)。这是研究交付；受众访谈、小样、独立方法对照与真实观看验证尚未执行。

- [面向其他 Agent 的 CLI 消费合同](interfaces/agent-cli-consumption.md)：CLI 唯一入口、JSON/agent/events/explain、运行回执、恢复和 Hermes/DSH 消费边界。
- [调度：OS 墙钟与 session 巡检](runtime/schedule.md)：systemd / launchd / Windows 任务 + Claude/Grok `/loop` 投影；session 不能替代早上 collect。

- [国内外市场变化 Radar](product/global-market-radar.md)：软件面已交付；红果 live 验证采样与 assignment 见 [radar-hongguo-live-assignment-v1](../openspec/changes/archive/2026-09-16-radar-hongguo-live-assignment-v1/)。
- [OpenSpec: radar-hongguo-catalog-parsing-v1](../openspec/changes/radar-hongguo-catalog-parsing-v1/)：红果目录解析清洗（标题/标签拆分、类目映射扩条目、字段覆盖率修复）；已交付。
- [OpenSpec: radar-market-pg-sync-v1](../openspec/changes/radar-market-pg-sync-v1/)：`radar market sync --to pg`，Drizzle 双方言把市场域数据幂等归档到用户提供的 PostgreSQL（SQLite 真源、PG 归档+分析副本）；已交付。
- [OpenSpec: radar-work-ingestion-gate-v1](../openspec/changes/radar-work-ingestion-gate-v1/)：candidate → canonical 正式入库门（审核、批量 review、拒绝原因、质量指标入 health）；已交付。`radar market canary report` 仍为 planned。
- [AGENTS.md](../AGENTS.md)：技术栈、架构边界、禁止事项、测试命令、14 天验证标准。
- [product/personal-drama-radar.md](product/personal-drama-radar.md)：既有个人化循环、Morning Edition、Hermes/DSH 与验证门；独立 Workbench 段落只保留历史背景。
- [hermes/radar-personal-brief-skill.md](hermes/radar-personal-brief-skill.md)：Hermes 用户级本地 Skill 草案（reader lane 只读简报；4.2 canary 前不发布公共 Skill）。
- [hermes/canary-runbook.md](hermes/canary-runbook.md)：单人 14 天 canary 与 5.3 隔离 Profile 验证操作手册（含通过门与脱敏记录表）。
- [hermes/transcript-sample.md](hermes/transcript-sample.md)：脱敏 dry-run transcript 样例（ready/absent/empty 三态与边界核查）。
- [OpenSpec: personalized-radar-agent-experience-v1](../openspec/changes/archive/2026-09-03-personalized-radar-agent-experience-v1/)：Profile、反馈、机会、Edition、CLI/MCP 和 canary 的实施真源。
- [OpenSpec: establish-crawler-first-radar](../openspec/changes/archive/2026-09-03-establish-crawler-first-radar/)：四层采集、快照、标准化、基础评分与 `short-drama-radar.card.v1` 兼容输出。

## 合同

- `short-drama-radar.card.v1`：已实现的通用榜单兼容合同，见 `src/pipeline/card.ts`，个人化变更不得改字段。
- `radar.personal_profile.v1`、`radar.preference_feedback.v1`、`radar.opportunity.v1`、`radar.personal_opportunity.v1`、`radar.morning_edition.v1`：由个人化 OpenSpec 定义，M1–M2 已实现（域模块 `src/profile/`、`src/pipeline/{feedback,opportunity,ranker,edition}.ts`）。
- `radar.production_assignment.v1`：Edition 绑定的生产任务，见 `src/pipeline/assignment.ts`。不调用 Auctra、不写 `used`。

## Optional consumers（不由本子项目背书实现）

独立 Workbench 已退役；DSH Drama Radar Pane 是现有 optional consumer，界面实现归 harness-plugins。新市场体验见 [DSH change](../../../agent/harness-plugins/openspec/changes/dsh-radar-market-intelligence-v1/design.md)。Radar 的软件合同完成与实际客户端、真实来源验收分别报告，不能相互替代。

后续文档按实际实施补充：Hermes 本地 canary runbook、评分/排序演进、账号池运维和外部消费者对接。

## CI/CD

- [模块化、分级 CI/CD](delivery/ci-cd.md)：quick、full、integration、release 的触发场景、真实命令和权限边界。

后续交付见[推进 DAG 与 Goal](product/greenlight-pilot/delivery-dag.md)：软件收口、真实观看、来源资格和十四天使用验证分别验收。任务声明与测试证据通过 `bun run scripts/delivery-status.ts` 检查。

首轮实验准备新增[G1 补证](product/greenlight-pilot/g1-evidence-update.md)和[访谈、询价与制作交接草案](product/greenlight-pilot/g1-execution-pack.md)。原始基线 missing，未执行真实招募；研究预算不设预定上限。
