# Design

## Context

本变更准备 辅助 Morning Edition 与中文阅读列表的相关性、重复性和待核实项判断。当前产品已有独立状态与审阅流程，接入不能把模型判断升级为 canonical truth。公共 SDK 与 TypeSafe adapter 尚待实现；此文档是实施方案，不表示能力已上线。

## Goals / Non-Goals

split-owner：Radar 拥有 intelligence/read-state/watch/Profile；SDK 不拥有市场评分与用户偏好。领域持有问题集、规则、权限和采纳；SDK 只负责基础合同与 transport。不得生成市场数据、把语言等同受众地区、自动修改 Profile、隐藏反例或把 judgment confidence 写入 evidence_confidence。不新增独立服务平台、通用 Agent 或第二套领域数据库。

## Decisions

### 消费位置与数据流

实施入口为 src/app、src/pipeline、src/market、src/profile 与既有 reading/Edition 投影；保持本地 CLI-first，不新增 MCP/server/消息机器人。如需新增内部模块，应复用这些应用服务边界，而非复制业务状态机。

```mermaid
flowchart LR
  I[领域已授权输入] --> P[规则检查与最小文本投影]
  P --> S[公共 SDK / 显式 transport]
  S --> E[领域脱敏 evidence 与待审建议]
  E --> R[原有人工审阅]
  R --> A[原有显式采纳服务]
```

输入：通过来源准入的 observation 摘要、work refs、语言/市场标签、Profile 的已授权偏好与当前 reading candidates。模型只接收有限 inline_text，不自行抓取 source URL、读取任意文件或解释权限。问题示例：“这条信息与当前关注的市场问题是否相关？与已有阅读项是否重复？是否缺少可核实的市场证据？” 每个问题保持原子化和明确答案域，question_set/version/digest 由 owner 维护，输出 pair 绑定原 candidate/question，缺项不得靠顺序猜测。

输出：可解释的阅读优先级建议、重复提示、unknown/needs-review 标签；保留原排序入口和全部候选。确定性检查先于模型；涉及权限、必需字段、类型和可计算约束的规则不能用概率替代。使用既有 CLI/application service 产生结构化投影和审阅状态，不手写元数据文件。

### 领域专属约束

初版按当前单用户真实阅读习惯验证，不以招募外部用户或 A/B 实验为前置条件。最先在用户显式请求的阅读评估中消费，schedule 不因升级自动产生付费调用。辅助排序不得改写 underlying observation/score；来源不足的市场推断保持 unknown。来源安全、地域覆盖、内容时效先用确定性规则；新颖性和相关性仅辅助。比较现有排序的有用条目留存率和漏看项，而不是只看模型自报高分。

### 交互与失败处理

默认 `off`：保持原命令、默认配置与数据，零发现/远程调用。显式 `shadow`：只比较建议与基线，也必须有数据与付费授权，不能由普通 read/status 命令暗中触发；显式 `assist`：展示建议、引用、缺失项和下一步现有审阅入口。首版不添加全屏 TUI 或自建客户端；已有 CLI/API 输出即可消费。

人工可查看理由摘要、接受/拒绝建议或回到原流程；接受建议仍要经过 owner 原有权限/审阅门。需要补充输入时给出具体缺失项；模型离线/不可用时显示 unavailable，不伪装成“没有问题”。低信心是 abstained，网络失败是执行错误，提交后超时是 outcome_unknown，不自动重发或切到另一个付费模型。旧 evidence 可零网络 replay；明确重新评估才建立新 attempt。

问题集/策略/模型采用精确版本，阈值按任务和语言校准，无全局 0.8 默认值。probability、provider confidence、source reliability 和事实正确性分开；未来 adapter 不提供的字段为 null，不补造。必需问题任何缺项/拒答阻止完整建议采纳。缓存由 owner 管，绑定 principal/project、授权版本、source/question/policy/model/adapter digest；发出请求和读缓存前都要核验权限。source 或权限变化后结果过期，禁止用于新版本采纳。

### 证据与兼容

证据保存 source refs/revisions/digests、规范化条目、question/policy version、exact model/adapter、attempt、已知 usage 或 unknown、拒答/错误类别及已有 review refs。不记录 raw prompt、原始 provider payload、secret、hidden prompt 或思维链。日志/输出使用脱敏英文摘要；用户设计文档使用中文。既有 JSON envelope、agent keys 和历史 reader 保持兼容，新信息只通过 owner 版本化可选投影增加。

SDK 不读取密钥；显式 transport 指向经过授权的 adapter，由 adapter 取用 credentialctl grant。领域配置只保存合法的引用与 transport 标识，不复制真实 key。未启用能力时不要求安装 provider CLI、启动 Aigora 或配置 TypeSafe。

## Scenario Matrix

| scenario_id | 目标用户 | job-to-be-done | 必需产物 | gate/review | export/handoff | readiness |
| --- | --- | --- | --- | --- | --- | --- |
| morning-relevance | 单用户阅读早报 | 按已选关注点辅助排序 | Edition refs 与建议 | 来源准入/覆盖检查 | 原 reading list | exploratory |
| cross-market | 跨中港台日韩欧美阅读 | 区分内容语言与目标市场 | locale 与 market 依据 | 缺资料保留 unknown | 原 market brief | exploratory |
| false-negative-retention | 发现被模型低估的线索 | 保留原列表并允许显式反馈 | 原排序/新建议对照 | 不得自动丢弃 | 既有 feedback 流程 | exploratory |

各行 evidence 路径统一为本项目 `temp/integration-test-runs/<run-id>/artifacts/`，引用原 owner source/review 状态，不创建另一套状态。各行 validation command 为 `bun test --timeout 30000`，实施时使用既有测试组织给场景建立非零用例；integration/component/e2e 通过本项目 evidence runner 包装，不能仅凭未匹配任何测试的退出码通过。

## Migration Plan

1. 先以假 transport 固定领域投影、问题集与版本绑定。
2. 公共 SDK 已可独立消费后添加可选依赖；TypeSafe adapter/grant 未就绪时保持 off 或 fixture，不阻塞原功能。
3. 增量增加审阅建议与 evidence reader；不回填或重写原业务文件与历史 hash。
4. 完成离线合同测试后才允许显式 live canary/校准；不在升级时自动启用。
5. 回滚将该可选能力关闭，恢复原流程，保留历史只读证据；不删除用户数据或凭据。

## Risks / Trade-offs

- [看似客观的高 confidence] → 清楚标识辅助建议，保留原审阅门与拒答；校准前不声称可靠。
- [上下文不足和中文效果差异] → 原子问题、限定输入、双语/领域留出集；不以连通测试冒充效果评估。
- [隐私、延迟和重复计费] → 最小授权投影、输入/调用上限、deadline、unknown outcome 与显式重试。

## Validation

当前方案验证：`openspec validate radar-reading-judgment-v1 --strict --no-interactive`。

实施时复用现有测试库与 runner：`bun test --timeout 30000`；先运行本变更的 focused tests，最后按本项目 AGENTS 完成必要质量门。离线测试覆盖上表业务情景、off 零调用、旧输出兼容、权限撤销、过期版本、缺失 required answer、null confidence、提交后断连、零网络 replay、恶意输入不能变成动作。不得读取用户实际项目或密钥，不依赖付费服务。

integration/component/e2e 通过现有 evidence runner 记录 `summary.json`、`command.txt`、`stdout.log`、`stderr.log`、`env.json`、`artifacts/`，失败保留原退出码和脱敏证据。真实模型效果需另行 opt-in：以小型已标注集探索，校准集与留出集分离，与原流程比较误报、漏报、有用建议、拒答率、延迟及已知用量；20–30 条只能作为探索起点，不能标注 mature。阈值和推广条件由本领域评估记录固定，合同测试通过不代表效果通过。

## Dependencies

- [公共 SDK 合同](../../../../../apigateway/aigora/openspec/changes/aigora-structured-judgment-sdk-v1/design.md)
- [可选 TypeSafe 适配器](../../../../../apigateway/aigora/openspec/changes/aigora-typesafe-judgment-adapter-v1/design.md)
- [跨项目 handoff](../../../../../openspec/changes/structured-judgment-sdk-adoption-v1/design.md)
