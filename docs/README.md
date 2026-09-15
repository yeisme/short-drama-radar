# short-drama-radar docs

本子项目的产品、设计、运行时与实施文档目录（子项目文档归属规则：root 不重复保存）。

- [面向其他 Agent 的 CLI 消费合同](interfaces/agent-cli-consumption.md)：CLI 唯一入口、JSON/agent/events/explain、运行回执、恢复和 Hermes/DSH 消费边界。

- [国内外市场变化 Radar](product/global-market-radar.md)：软件面已交付；红果 live 验证采样与 assignment 见 [radar-hongguo-live-assignment-v1](../openspec/changes/radar-hongguo-live-assignment-v1/)。
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
