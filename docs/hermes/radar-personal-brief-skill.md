---
name: radar-personal-brief
description: 每日个人短剧机会简报。通过本地 `radar mcp --transport stdio --lane reader` 只读最近一个已完成 Morning Edition；无 Edition、过期、空榜或降级时给出真实原因与可运行的 radar 命令；用户明确确认后可经 curator lane 写入 saved/dismissed 等反馈提案。绝不自行触发采集、绝不修改 Profile 真源。
version: 0.1.0
metadata:
  hermes:
    tags: [radar, short-drama, morning-brief, mcp, reader]
---

# Hermes 用户级本地 Skill：radar-personal-brief

状态：canary 草案（M4，未发布公共 Skill）。默认 reader lane，只读。本文件可直接作为 Hermes Skill 主体，放入 `$HERMES_HOME/skills/radar-personal-brief/SKILL.md`；默认 `$HERMES_HOME=~/.hermes`。Radar 仓库不自动安装或修改用户的 Hermes 配置。

## 连接配置

```bash
hermes mcp add radar \
  --connect-timeout 30 \
  --command bun \
  --args /absolute/path/to/short-drama-radar/src/cli.ts mcp --transport stdio --lane reader
hermes mcp test radar
```

- 首次 `mcp add` 会展示发现的工具并要求确认；reader lane 应发现 `radar.search` 和被 lane 拒绝 mutation 的 `radar.execute`。
- 默认 lane=reader：只有 `radar.search` 可读，`radar.execute` 全部拒绝。
- 反馈写入需用户显式确认后，由用户把 lane 切到 curator（Hermes 不持有 operator lane）。
- Profile 修改永远不进 MCP：Hermes 只能返回 `radar profile set ...` 建议命令。

## Briefing 流程（严格只读）

1. 读 `radar://capabilities` —— 确认 `mcp_stdio_lanes=ready`；remote/A2A/公共 Skill 必须 `unavailable|planned`，不要尝试。
2. 读 `radar://sources/status` —— 任一采集层 degraded 时在简报中明示"指标是下界"。
3. 读 `radar://editions/latest`，按状态分支：
   - `ready`：输出机会（topic/hook、market score、personal fit、evidence confidence）、每个机会的 reason codes、风险（degraded/low_confidence 项）与建议下一步命令。
   - `empty`：把 limitations 原样转述（阈值 / blocked topics / 数据缺失 / already_seen），并给出对应命令：
     - 数据缺失 → `radar run`
     - 阈值过高 → `radar profile set --minimum-fit <n>`
   - `degraded`：正常输出条目，但必须附"部分证据为降级采集"提示。
   - `absent`（无任何 Edition）→ 建议先 `radar profile create --name <name>`（若无 profile）再 `radar run`。
4. 引用必须带 ref：profile revision、edition ref、opportunity ref、evidence digest。Hermes memory 与这些 ref 冲突时，以 Radar resource 为准。

## 硬边界

- 不调用 collect/daily_run（operator-only 且有外部平台副作用）；Edition 不新鲜时只报告并给命令。
- 不伪造 ready；blocked/unavailable 能力只引用 `radar://capabilities` 原文。
- 反馈走 `radar.execute feedback_add`（curator，需用户确认），幂等键由 Hermes 生成；重放返回原 receipt。
- 提案大纲可写（非 canonical），但不得自动持久化为下游项目、批准或启动生产。
- 审计文件不可读（MCP 无审计 URI）；审计查询只属于用户在终端运行 `radar audit tail`。
