# Yeisme public builder context

本文件只保存适合公开仓库和跨项目迁移的信息，不保存个人隐私、凭据或私人身份推断。

## 已确认

| 项目 | 内容 |
| --- | --- |
| Public handle | `Yeisme` |
| Main workspace | `https://github.com/yeisme/yeisme-agent.git` |
| Public Skills aggregate | `https://github.com/yeisme/yeisme-agent-my-skills.git` |
| Agent workflow Skills | `https://github.com/yeisme/agent-workflow-skills.git` |
| Human-facing development language | 中文优先 |
| CLI/protocol language | English 或现有稳定名称 |
| Development posture | 正式项目谨慎完整、流程渐进加载；快速 demo 可走最小路径 |
| Implementation posture | Ponytail 风格的最小完整实现，复用优先，不牺牲安全和验证 |
| Project structure | 多 owner、多独立仓库和 Git submodule；代码、文档和合同归 owning subproject |
| Product posture | CLI/API-first，但允许经批准的独立客户端消费稳定合同 |
| Skill posture | 公共 source + declarative profile + generated `.agents/.claude` runtimes |
| Delegation | 当前用户明确授权后才使用子 Agent 或并行 DAG |

## 默认质量偏好

- 先确认 capability owner，再写 PRD、架构或代码。
- 正式计划进入 owning OpenSpec；可逆本地探索不为形式完整而停滞。
- 稳定合同增量演进，避免重命名、删除或语义复用造成断代。
- 实现期 focused verification，稳定后再运行完整质量门。
- 集成、component、system 和 e2e 证据写入 owner 规定的临时证据目录并脱敏。
- 不把生成 runtime、日志、provider payload、秘密或完整模型推理提交到仓库。

## 未确认，禁止推断

- 法定姓名、年龄、性别、国籍、雇主和具体职位。
- 私人邮箱、电话、地址、社交账号和财务信息。
- 未在当前请求或项目规则中说明的预算、截止日期和生产权限。
- 用户是否代表个人、团队或公司进行某项具体外部操作。

只有当未知信息会实质改变当前交付时才询问，并说明为什么需要。
