---
name: radar-personal-brief
description: 每日个人短剧机会简报。通过本地 `radar edition show latest --json` 读取最近一个已完成 Morning Edition；无 Edition、过期、空榜或降级时给出真实原因与可运行的 radar 命令。反馈通过明确的 radar CLI 命令执行，绝不自行触发采集或修改 Profile 真源。
version: 0.1.0
metadata:
  hermes:
    tags: [radar, short-drama, morning-brief, cli]
---

# Hermes 用户级本地 Skill：radar-personal-brief

状态：CLI 消费草案（未发布公共 Skill）。本文件可直接作为 Hermes Skill 主体，放入 `$HERMES_HOME/skills/radar-personal-brief/SKILL.md`；Radar 仓库不自动安装或修改用户的 Hermes 配置。

## 连接配置

```bash
command -v radar
radar doctor --json
```

- Hermes 只执行 CLI 读取命令，不连接 Radar 服务。
- 反馈写入必须得到用户确认，再执行明确的 `radar feedback add ...` 命令。
- Profile 修改永远由用户确认后执行 `radar profile set ...`。

## Briefing 流程（严格只读）

1. 运行 `radar doctor --json`，确认本地 CLI 和渠道状态；无可用来源时按回执中的恢复命令处理。
2. 运行 `radar doctor --json`，读取渠道状态—— 最近采集 degraded 或登录材料缺失时在简报中明示"指标是下界"。
3. 运行 `radar edition show latest --json`，按状态分支：
   - `ready`：输出机会（topic/hook、market score、personal fit、evidence confidence）、每个机会的 reason codes、风险（degraded/low_confidence 项）与建议下一步命令。
   - `empty`：把 limitations 原样转述（阈值 / blocked topics / 数据缺失 / already_seen），并给出对应命令：
     - 数据缺失 → `radar run`
     - 阈值过高 → `radar profile set --minimum-fit <n>`
   - `degraded`：正常输出条目，但必须附"部分证据为降级采集"提示。
   - `absent`（无任何 Edition）→ 建议先 `radar profile create --name <name>`（若无 profile）再 `radar run`。
4. 引用必须带 ref：profile revision、edition ref、opportunity ref、evidence digest。Hermes memory 与这些 ref 冲突时，以 Radar resource 为准。

## 硬边界

- Edition 不新鲜时只报告并给命令，不自动触发采集。
- 不伪造 ready；blocked/unavailable 能力只引用 `radar doctor --json` 原文。
- 反馈使用 `radar feedback add`（需用户确认），重复执行遵循 CLI 回执。
- 提案大纲可写（非 canonical），但不得自动持久化为下游项目、批准或启动生产。
- Hermes 不读取 Radar 数据库或内部审计文件，只消费 CLI 输出和导出回执。
