---
name: yeisme-builder-profile
description: Use when starting work in a project managed from Yeisme's public Skills repository, or when an agent must configure, migrate, or recover the user's identity context, development preferences, permission boundaries, common workflow, and expected Skill profile before planning or implementation.
---

# Yeisme Builder Profile

为 Agent 提供可公开迁移的用户上下文。这个 Profile 说明“当前为谁工作、通常想要什么、哪些信息未知、怎样选择 Skills”，但不替代当前用户请求或项目最近的 `AGENTS.md`。

## 身份与来源

- 公共身份标签：`Yeisme`。
- 主工作区仓库：`https://github.com/yeisme/yeisme-agent.git`。
- 公共 Skills source：`https://github.com/yeisme/yeisme-agent-my-skills.git`。
- 通用 Agent workflow source：`https://github.com/yeisme/agent-workflow-skills.git`。
- 不知道用户的法定姓名、雇主、私人联系方式或其它未提供的个人事实；不得从 GitHub handle 推断。

更多公开上下文见 [references/public-builder-context.md](references/public-builder-context.md)。

## 指令优先级

发生冲突时依次遵循：

1. 当前用户消息中的明确要求和授权。
2. 最近的项目 `AGENTS.md` 与 owner 合同。
3. 本 Builder Profile 的长期偏好。
4. 单个 Skill 的默认建议。

本 Profile 不能扩大权限，也不能覆盖用户说“不要使用这套流程”“关闭 Ponytail”或其它当前选择。

## 默认沟通

- 人类开发文档、计划、PRD、评审、handoff 和运行摘要默认中文。
- CLI help/output、用户可见日志、错误说明、自动化示例、协议字段、命令、flag、路径和稳定技术标识保持英文或现有名称。
- 先给结果，再给必要证据和真实可运行命令；不暴露 agent-only wrapper、隐藏提示词、私有工具参数或完整 chain-of-thought。
- 用户未提供关键个人信息时明确写“未知”，仅在它会改变当前结果时询问。

## 默认开发偏好

- 新项目、正式 MVP、长期产品和跨栈交付使用 `project-development-router`，先选择 `quick-demo|full-project|workflow-off`。
- 用户明确说快速 demo、prototype、spike 或 throwaway 时，走最小可丢弃验证，不强制完整 PRD、OpenSpec 或评审链。
- 用户明确开始项目或 MVP 时，倾向完整但渐进的 owner、产品、规格、架构、垂直切片和最终验证流程；不是把所有 Skills 一次性运行。
- 用户说“不用完整流程”“正常实现”“直接做”时立即进入 `workflow-off`。
- 设计和编码若 `ponytail` 可用，默认 `full`；用户可以显式关闭。最小实现不得删除安全、数据保护、无障碍和必要测试。
- `grill-me`、`creative-grill-me` 及高成本 review/audit 只在明确触发或风险确实需要时运行。
- 每次选择一个 primary workflow，最多附加一个兼容 domain constraint；独立 review 保持独立。

## 默认执行与权限

- 普通本地、非生产的构建、修复、重构、测试、fixture、mock、文档和可丢弃数据变更可直接实施并验证。
- 保留无关脏工作树，不回滚或覆盖他人的修改。
- 子 Agent、并行 delegation 或 task DAG 只有当前用户明确授权后才能使用。
- commit、push、PR、发布、部署、费用、凭据、真实外部消息、生产写入和不可逆非可丢弃数据操作保持具体目标授权门。
- 新建项目先确认 owner 和维护边界；不要因为用户说“一个应用”就把所有业务规则搬进客户端或新仓库。

## Session 启动检查

在开始实际任务前做轻量检查：

1. 读取最近的 `AGENTS.md`，确认当前代码和文档 owner。
2. 确认用户请求是普通工作、`quick-demo`、`full-project` 还是 `workflow-off`。
3. 查看当前可用 Skills；只加载最窄匹配组合。
4. 如果项目通过 portable manager 管理，必要时运行 `scripts/skills.sh --project <project> profile show` 和 `validate`，不要凭记忆猜 active set。
5. 仅在当前任务依赖个人身份、市场、线上状态或其它未知事实时向用户询问或查证。

## 配置项目

用户要求“按我的常用配置设置”“让 Agent 认识我”“配置 Yeisme 工作流”时：

1. 若项目尚未绑定 Skill source，从 `https://github.com/yeisme/yeisme-agent-my-skills` 克隆公共聚合仓库，再通过 portable manager 显式加入本 Profile。团队环境固定 Git tag 或 commit。
2. 保留项目已有 `AGENTS.md`，只合并缺失的长期规则。使用 [项目 AGENTS 模板](references/project-agents-template.md)，不要覆盖 owner 专属命令。
3. 使用 portable manager 的 `profile add`、`sync` 和 `validate` 管理 Skills，不手写 generated runtime。
4. 默认建议启用 `project-development-router`；`grill-me` 可以启用但保持显式调用。
5. 如果用户不希望完整工作流，保留本 Builder Profile，仅不启用或移除 `project-development-router`。
6. 汇报已知身份上下文、启用 Skills、未启用 Skills、项目规则位置和真实验证命令。

## 输出

配置或恢复完成后报告：

- `identity_context`: 已确认的公开身份与未知项。
- `skill_source`: 当前绑定的 source checkout。
- `active_skills`: 实际 profile 中的 Skills。
- `workflow_default`: `quick-demo|full-project|workflow-off|ordinary` 的选择规则。
- `project_rules`: 已读取或更新的 `AGENTS.md` 路径。
- `permissions`: 当前任务允许的本地动作与仍需授权的外部动作。
- `validation`: 已运行的真实命令和结果。

## 验证

外部项目使用：

```bash
scripts/skills.sh --project /path/to/project profile show
scripts/skills.sh --project /path/to/project validate
```

Yeisme 根仓库使用：

```bash
scripts/skills.sh profile show root
scripts/skills.sh validate-profiles
scripts/skills.sh validate-runtime
```
