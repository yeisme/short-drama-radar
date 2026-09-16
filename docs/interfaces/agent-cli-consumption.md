# Radar 面向其他 Agent 的 CLI 消费合同

Radar 是本地 CLI 产品。其他 Agent 通过执行 `radar` 命令、解析标准输出并读取用户级运行回执使用 Radar；不连接 SQLite、不加载 Radar 内部模块、不维护第二份 Profile／Edition，也不依赖 MCP、HTTP 或常驻 Radar 服务。

## 接入前检查

Agent 先确认命令位置和能力：

```bash
command -v radar
radar --help
radar doctor --json
```

如果仓库没有全局 `radar`，使用项目入口：

```bash
cd /path/to/short-drama-radar
bun run src/cli.ts doctor --json
```

Agent 不应自行安装凭据、导出 Cookie、启动浏览器登录或猜测渠道命令。`doctor` 返回的 `actions[].command` 才是下一条可执行建议；外部登录和账号配置由用户完成。

## 读取流程

推荐的只读流程：

```bash
radar doctor --json
radar runs --json
radar edition show latest --json
radar market brief show --json
radar schedule session-plan --runtime both --json
```

无版次时，Agent 应把 `status`、`error.code`、`facts` 和 `actions` 原样转述，并建议真实命令，例如：

```bash
radar profile create --name main
radar run --json
```

Agent 不因空结果自行降低 Profile 阈值，不把 degraded 当成 ready，也不把旧 run 当成当天数据。

## 搜索与采集流程

联网搜索和采集由 Radar CLI 发起；Agent 只负责组装明确参数、读取结果和展示证据：

```bash
radar market search --query "短剧 复仇" --channels xiaohongshu,douyin,bilibili --json
radar market search show --run <run-ref> --json
radar market observe --source xiaohongshu --query "短剧" --json
```

每个渠道结果必须检查：

- `status`：`ready|empty|partial|blocked|unavailable`；
- 实际后端及版本；
- 查询、语言、地区、时间窗口和分页；
- 稳定对象 ID 与公开链接；
- evidence refs、采样时间和降级原因。

小红书只使用 CLI 后端：

```bash
opencli xiaohongshu search "短剧" -f json
```

Radar 不提供或调用小红书 MCP。OpenCLI 不可用时，使用 Agent Reach 报告的其他 CLI；不能静默切换到未声明后端。

## 输出解析

`--json` 是机器读取的首选，顶层 envelope 为 `spec_version=1.0`。Agent 只依赖稳定字段：

```text
spec_version, mode, command, status, summary,
facts, actions, evidence, confidence, data, error
```

轻量脚本可使用：

```bash
radar edition show latest --agent
radar run --events
radar market brief show --explain
```

`--agent` 只返回稳定 key=value；大对象通过 `data_ref` 表示。`--events` 是 NDJSON，按 `seq` 递增，最后一行必须是 `end` 或 `error`。`--explain` 是脱敏英文审阅摘要，不能当作完整推理。

Agent 不解析人类 summary 来判断成功，不依赖字段未声明的嵌套结构，不把 stdout 中的错误文本当作 JSON 数据。退出码非零时保留最小错误摘要并停止自动重试。

## 运行回执与恢复

每次采集、搜索、导入和构建都绑定 run ref。Agent 遇到超时、断线或响应不明时，先查询原 run：

```bash
radar runs --json
radar market search show --run <run-ref> --json
```

只有明确确认原命令没有生成回执，才允许使用同一幂等参数再次执行。读取 run 不会重新联网，不会自动标记已读，也不会修改 Profile。

导出给另一个 Agent 时使用 CLI 生成的文件：

```bash
radar market export --run <run-ref> --format json
radar market export --run <run-ref> --format markdown
```

导出文件是只读投影。接收方不能修改后重新导入来伪造 live 来源、资格、时间或证据；桌面导入仍标记为 manual。

## 写入动作

Profile 和反馈是唯一常见的用户状态写入，必须由用户明确意图或宿主确认后执行：

```bash
radar profile set --risk-tolerance 60
radar feedback add --opportunity <ref> --kind saved
radar edition build --limit 8
```

Agent 不直接修改配置文件、数据库、运行回执、Profile revision 或结构化导出。重复写入使用同一业务引用和幂等键，遇到 `state_conflict` 先重新读取当前 revision。

## 消费者职责

| 消费者 | 允许做什么 | 不得做什么 |
|---|---|---|
| Hermes | 调用只读 CLI、展示 Edition／brief、提出下一条命令 | 自动采集、自动降阈值、修改 Profile |
| DSH Pane | 读取 JSON／Markdown 回执、展示状态和证据、链接到公开来源 | 读取 Radar SQLite、复制 Edition 真源、接管渠道登录 |
| 其他 Agent | 搜索、读取、导出、在确认后执行反馈命令 | 调用内部模块、猜测后端、把缓存当实时数据 |

消费者应展示 source status、confidence、degraded、evidence refs 和下一步命令，让用户能判断“没有变化”和“没有采到”的区别。

## 兼容和验证

消费者只依赖 CLI 合同，不依赖内部文件路径。接入验证使用：

```bash
radar --help
radar doctor --json
radar edition show latest --json
radar run --events
bun run typecheck
bun test
```

产品 CLI、渠道后端、回执文件、Hermes/DSH 展示和真实平台资格分别验收。任何渠道没有稳定 CLI 或授权能力时，消费者必须显示 `blocked`／`unavailable` 和恢复命令，不能声称已覆盖。
