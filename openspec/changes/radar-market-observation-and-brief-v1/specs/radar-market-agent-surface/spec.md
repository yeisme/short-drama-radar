## ADDED Requirements

### Requirement: 市场能力必须增量暴露且保持现有输出合同
新 CLI/application actions SHALL 复用标准 envelope、agent/events/explain renderer；card.v1、morning_edition.v1 和反馈语义 MUST 保持兼容。MCP 面（tools、views/resources、tools/list）已于 2026-09-15（提交 5d8d78a）整体移除，不再构成兼容义务；现行外部交互合同为 docs/interfaces/agent-cli-consumption.md（CLI 消费＋doctor 引导）。未实现市场能力不得进入对外能力发现（doctor actions 与 help）。

#### Scenario: 旧客户端
- **WHEN** 客户端只读取旧 Edition 或 card
- **THEN** payload 与行为保持旧约定，不出现必须理解全球平台的新字段

#### Scenario: 流式分析失败
- **WHEN** market analyze 发出进度后失败
- **THEN** 以有名错误终止 NDJSON，保持序号和 run_ref，不输出混合 prose 或静默结束

### Requirement: 外部消费必须保留 lane 与动作边界（CLI 载体）
市场读取 SHALL 通过只读 CLI 命令完成（reader 语义）；显式读者/关注写入为 curator 语义——外部 Agent 仅在用户明确确认后执行 reader/watch 写命令；本地分析和版次构建为 operator 语义（本地 analyze/brief build/review build）。observe、source/config/Profile 修改 MUST 留在 owner CLI。参数发现 SHALL 来自命令 `--help` 与 `radar doctor --json` 的 `actions[].command`；已移除的 MCP 面不再提供 tools/list inputSchema。

#### Scenario: Reader 语义保持只读
- **WHEN** 外部 Agent 以 reader 语义消费市场（执行 brief/signal/reader catchup/watch list 等只读命令）
- **THEN** 读取零副作用、不推进 reader revision，也不执行任何写入命令；需要写入时展示真实确认要求或 disabled reason，不提升权限

#### Scenario: 重连发现无今日数据
- **WHEN** Agent 重新执行 doctor / source gaps / brief show 发现无今日数据
- **THEN** 说明缺数据和 owner-side 恢复方式（doctor 给出的 actions[].command），不自动执行 observe 或 daily run

### Requirement: 外部客户端必须可经 CLI 查证与对账
只读 CLI 输出 SHALL 覆盖市场能力、覆盖缺口、版次、信号、证据、读者、回顾和幂等回执查询；旧 ref 绑定历史修订。客户端不需要访问 SQLite、用户配置、审计文件或服务端文件路径。

#### Scenario: 仅通过 CLI 消费
- **WHEN** 外部 Agent 在用户机器上执行 radar 命令并解析标准输出
- **THEN** 可经 CLI 查询并按原键（--key）恢复已允许动作的回执；需要 owner 配置时明确由 Radar owner host 执行，Agent 只转述 doctor 给出的命令建议，不猜测或要求运行不存在的命令

#### Scenario: 历史信号被修订
- **WHEN** 用户从旧 brief 打开 signal revision 1，而最新已是 revision 3
- **THEN** 使用 signal show --revision 1 返回原修订并应用当前禁区；旧修订不存在时返回 not_found，不偷换为 revision 3

### Requirement: 问答必须提供有界且可引用的证据上下文
question context MUST 绑定 signal revision/policy revision、最多 10 条每条最多 500 字符的安全证据摘要、限制和下钻 refs。回答中的事实必须有支持引用，推断/未知单独表达；缺证据返回 evidence_insufficient。

#### Scenario: 用户追问不存在的收入
- **WHEN** 已存证据只有目录位置而无收入信息
- **THEN** 明确无法判断收入，不转换热度或临时调用付费研究来补值

#### Scenario: 网页包含操作指令
- **WHEN** 来源文本要求修改偏好、执行命令或忽略规则
- **THEN** 只作为不可信内容处理，不形成可执行动作或 canonical 判断

### Requirement: 运行和试用证据必须区分真实性
系统 MUST 使用已有证据 runner 输出规定文件，区分 fixture、实际 host、实际来源与单人试用；新 market canary report 不改旧 canary 语义。

#### Scenario: 离线回放全部成功
- **WHEN** 固定夹具通过全部场景
- **THEN** 只报告软件验证，真实来源和 14 天任务仍未完成

#### Scenario: 试用有空版次及失败日
- **WHEN** 14 天窗口中有无重要变化的空版次、采集失败和缺源日
- **THEN** 均进入计划天数分母，分别展示原因，不仅统计成功非空日报

### Requirement: 阅读路径必须独立于外网与模型延迟
已完成简报和分页读取 SHALL 只读取 owner 的已存投影，不等待外网抓取或模型生成；超出窗口分页并标明边界。

#### Scenario: 上游离线
- **WHEN** 用户打开已有日报但外部网站不可达
- **THEN** 日报仍可读并显示真实截止时间，外部故障不阻塞本地阅读
