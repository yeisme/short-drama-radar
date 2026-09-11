## ADDED Requirements

### Requirement: 市场能力必须增量暴露且保持现有输出合同
新 CLI/application actions SHALL 复用标准 envelope、agent/events/explain renderer；card.v1、morning_edition.v1、旧 MCP views/resources 和反馈语义 MUST 保持兼容。未实现市场能力不得进入可执行 discovery。

#### Scenario: 旧客户端
- **WHEN** 客户端只读取旧 Edition 或 card
- **THEN** payload 与行为保持旧约定，不出现必须理解全球平台的新字段

#### Scenario: 流式分析失败
- **WHEN** market analyze 发出进度后失败
- **THEN** 以有名错误终止 NDJSON，保持序号和 run_ref，不输出混合 prose 或静默结束

### Requirement: MCP 必须保留 lane 与外部动作边界
市场读取 SHALL 使用 reader；显式读者/关注写入为 curator；本地分析和版次构建为 operator。observe、source/config/Profile 修改 MUST 留在 owner CLI。所有参数从 tools/list 的 inputSchema 获取。

#### Scenario: Reader 尝试标记已读
- **WHEN** reader lane 提交 market_reader_mark
- **THEN** 拒绝写入且不提升权限，展示真实 disabled reason

#### Scenario: 重连发现无今日数据
- **WHEN** 已连接 Agent 重读 capabilities/coverage/brief
- **THEN** 说明缺数据和 owner-side 恢复方式，不自动执行 observe 或 daily run

### Requirement: 无本机 CLI 的客户端必须可查证与对账
资源 SHALL 暴露市场能力、覆盖、版次、信号、证据、读者、回顾和幂等回执；旧 ref 绑定历史修订。客户端不需要访问 SQLite、用户配置、审计文件或服务端文件路径。

#### Scenario: 仅连接 MCP
- **WHEN** 用户所在机器未安装 radar
- **THEN** 仍可通过资源查阅并按原键恢复已允许动作；需要 owner 配置时明确执行 host，不要求运行不存在的本机命令

#### Scenario: 历史信号被修订
- **WHEN** 用户从旧 brief 打开 signal revision 1，而最新已是 revision 3
- **THEN** 使用 revisions/1 资源返回原修订并应用当前禁区；旧修订不存在时返回 not_found，不偷换为 revision 3

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
