## Why

通用短剧热榜只能回答“市场上什么在涨”，不能回答“哪些机会适合我现在的题材、预算、资产和风险偏好”。`short-drama-radar` 需要从榜单采集器演进为单人优先的个人化机会雷达，同时保持可解释、可回放和本地真源。

## What Changes

- 引入通用且版本化的个人 Profile；本地允许多个命名 Profile，但同一时刻只有一个 active profile，不引入账号、租户或多人权限模型。
- 将题材/话题机会簇作为主要排序对象，原始视频与榜单项作为证据；分别输出 market score、personal fit 与 evidence confidence。
- 引入 append-only 偏好反馈，使用确定性、版本化的规则重排；blocked topics 先硬过滤，反馈只能在有界范围内调整排序。
- 新增个人化 Morning Edition，允许高精度空榜，历史 Edition 固定绑定 profile revision、ranker version 与证据快照，不因后续反馈改写。
- 扩展 CLI 的 profile、feedback 与 edition 命令，并为自动化补齐 `--agent` 与长任务 `--events`。
- **BREAKING（仅针对尚未公开发布的 0.0.x 草案）**：在首个公开版本前，将现有 `--json` 草案统一为仓库标准 envelope；不为未发布格式建立长期兼容桥。
- 将 MCP 收敛为 `radar.search`、`radar.execute`、`radar://` resources 与 `radar_personal_brief` prompt，采用 reader / curator / operator 三条 lane；Profile 修改只允许经 CLI 完成。
- 以 Hermes 用户级本地 Skill 做只读优先 canary；Hermes 读取已完成 Edition、可写反馈提案，但不拥有调度、Profile 真源或自动 production greenlight。
- 保持 `short-drama-radar.card.v1` 字段与 golden fixture 不变，继续作为旧榜单消费者的兼容输出。
- 不实现远程 MCP endpoint、A2A、实时通知、云同步、团队/组织权限、聊天 provider SDK 或自动批准生产。

## Capabilities

### New Capabilities

- `personal-radar-profile-feedback`: Profile、active profile、append-only feedback、版本与隔离规则。
- `personal-opportunity-edition`: 机会聚类、确定性个人重排、Morning Edition、解释与历史不可变语义。
- `radar-cli-agent-contract`: 人类/JSON/agent/events 输出、命令面、兼容与错误合同。
- `radar-mcp-hermes-surface`: MCP tools/resources/prompts、lane、审计、恢复与 Hermes 本地 canary。

### Modified Capabilities

无。现有爬虫主路变更继续负责采集、快照、标准化、基础评分与 `short-drama-radar.card.v1`；本变更新增个人化投影，不改写其既有合同。

## Impact

- 代码 owner：`cli/short-drama-radar`；预计影响 `src/db/**`、`src/pipeline/**`、`src/cli.ts`、新增 MCP/application service、测试与用户级配置/审计路径。
- 数据迁移：SQLite additive migration；旧表和 `card.v1` 可继续读取，回滚时忽略新增表/列，不删除历史数据。
- 新依赖候选：MCP 官方 TypeScript SDK；只有 Bun 兼容和 stdio lifecycle 测试通过后才进入实现。
- 消费者：Hermes 只消费本地 MCP/CLI 安全投影；Workbench 与 DSH 的跨项目组合由根级 `personalized-short-drama-radar-experience-v1` 跟踪。
- 验证：先完成 14 天单人 canary，再使用 5–8 个相互隔离的 Profile/用户样本验证解释性差异；未过门不得宣称公共 Skill 或远程服务 ready。
