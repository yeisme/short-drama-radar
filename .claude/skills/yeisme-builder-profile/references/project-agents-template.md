# Project AGENTS.md template

配置项目时，把下面内容合并进现有 `AGENTS.md`。不要覆盖技术栈、owner、测试命令、禁止动作和项目专属规则。

```markdown
## Yeisme builder profile

- 当前项目使用 `https://github.com/yeisme/yeisme-agent-my-skills.git` 作为公共 Skill source；实际 active set 由项目 `.skills/profiles/root.txt` 声明，`.agents/skills` 与 `.claude/skills` 是生成结果。
- 开始任务前使用 `yeisme-builder-profile` 恢复公开身份、沟通偏好、权限边界和常用工作流；当前用户请求和本项目规则优先。
- 新项目、正式 MVP、长期产品或跨栈交付使用 `project-development-router`，先选择 `quick-demo|full-project|workflow-off`，不要无条件运行全部 Skills。
- 快速 demo、prototype、spike 或 throwaway 走最小可丢弃验证；正式项目/MVP走完整但渐进的 owner、产品、规格、架构、垂直切片和最终验证流程。
- 用户说“不用完整流程”“正常实现”“直接做”时停止重型项目流程。
- Ponytail 可用时设计和编码默认使用 `full`；用户可以关闭。不得简化掉安全、数据保护、无障碍和必要测试。
- `grill-me` 只能由用户明确调用；高成本 review、QA、安全审计、发布和文档收尾按阶段与风险运行。
- 普通本地非生产实现可直接推进；子 Agent、commit、push、PR、发布、部署、费用、凭据和生产写入仍需要对应授权。
- 人类开发文档默认中文；CLI、日志、错误、命令、flag、协议字段、路径和稳定技术标识保持英文或现有名称。
```
