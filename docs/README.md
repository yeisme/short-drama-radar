# short-drama-radar docs

本子项目的产品、设计、运行时与实施文档目录（子项目文档归属规则：root 不重复保存）。

- [AGENTS.md](../AGENTS.md)：技术栈、架构边界、禁止事项、测试命令、14 天验证标准。
- [product/personal-drama-radar.md](product/personal-drama-radar.md)：单人优先的产品定位、个人化循环、Morning Edition、Hermes/Workbench/DSH 入口与验证门。
- [interfaces/mcp-cli-interaction.md](interfaces/mcp-cli-interaction.md)：CLI/MCP/Hermes 稳定表面、三 lane、资源、审计与恢复语义（M1–M3 已实现）。
- [interfaces/mcp-handoff-fixtures.json](interfaces/mcp-handoff-fixtures.json)：根级消费者交接 fixture：capability digest、工具/资源/prompt 面、disabled states 与排除清单（无 DB/审计/凭据/raw payload；validator 测试锁定与实际表面同步）。
- [hermes/radar-personal-brief-skill.md](hermes/radar-personal-brief-skill.md)：Hermes 用户级本地 Skill 草案（reader lane 只读简报；4.2 canary 前不发布公共 Skill）。
- [hermes/canary-runbook.md](hermes/canary-runbook.md)：单人 14 天 canary 与 5.3 隔离 Profile 验证操作手册（含通过门与脱敏记录表）。
- [hermes/transcript-sample.md](hermes/transcript-sample.md)：脱敏 dry-run transcript 样例（ready/absent/empty 三态与边界核查）。
- [OpenSpec: personalized-radar-agent-experience-v1](../openspec/changes/personalized-radar-agent-experience-v1/)：Profile、反馈、机会、Edition、CLI/MCP 和 canary 的实施真源。
- [OpenSpec: establish-crawler-first-radar](../openspec/changes/establish-crawler-first-radar/)：四层采集、快照、标准化、基础评分与 `short-drama-radar.card.v1` 兼容输出。

## 合同

- `short-drama-radar.card.v1`：已实现的通用榜单兼容合同，见 `src/pipeline/card.ts`，个人化变更不得改字段。
- `radar.personal_profile.v1`、`radar.preference_feedback.v1`、`radar.opportunity.v1`、`radar.personal_opportunity.v1`、`radar.morning_edition.v1`：由个人化 OpenSpec 定义，M1–M2 已实现（域模块 `src/profile/`、`src/pipeline/{feedback,opportunity,ranker,edition}.ts`）。
- `radar.mcp.audit.v1`、`radar.mcp.handoff.v1`：M3/M4 新增（`src/mcp/audit.ts`、`docs/interfaces/mcp-handoff-fixtures.json`）。

## Optional consumers（不由本子项目背书实现）

Workbench Personal Radar Lens 与 DSH Drama Radar Pane 是 optional consumer：各自实现归
[change `personalized-radar-agent-experience-v1`](../openspec/changes/personalized-radar-agent-experience-v1/) 跟踪；Radar 只承诺
`docs/interfaces/mcp-handoff-fixtures.json` 中的稳定表面，客户端实现不是 Radar 的完成条件。

后续文档按实际实施补充：Hermes 本地 canary runbook、评分/排序演进、账号池运维和外部消费者对接。

## CI/CD

- [模块化、分级 CI/CD](delivery/ci-cd.md)：quick、full、integration、release 的触发场景、真实命令和权限边界。
