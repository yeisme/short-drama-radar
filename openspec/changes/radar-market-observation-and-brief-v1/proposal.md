## Why

现有 Radar 的两平台候选榜和 personal_fit 排序无法替代用户反复刷国内外平台的工作：缺少稳定的市场比较窗口、变化解释、跨日阅读连续性。用户已接受“每日 3–5 分钟市场变化简报＋Agent/DSH 深看”及五项扩展，要求来源选择由 Agent 主动分析，红果列入国内核心观察。

## What Changes

- 增加来源资格、地区/语言/形式口径、作品与观测身份、可比历史、变化信号及更正。
- 增加独立市场简报，不需要先创建创作 Profile；已存在的明确内容禁区继续在所有读取出口执行。
- 增加显式阅读补看、观察清单、跨市场对照、周度回顾及证据问答所需的只读上下文。
- 增加 CLI/application service 和可协商 MCP 市场能力，复用 Drizzle SQLite、输出 envelope、审计及运行证据。
- 保留原采集、card.v1、个人 Profile/feedback/opportunity/morning_edition.v1；新市场 pipeline 单独启用，不改变旧定时器语义。
- 来源资格、离线软件验收与 14 天真实观察分开；不会把官网可读、商店身份或 fixture 成功标为 live-ready。

## Capabilities

### New Capabilities

- `radar-market-observations`：多地区来源资格、标准化观测、来源口径和作品身份。
- `radar-market-signals-briefs`：可比信号、版次、更正、跨市场对照与周度回顾。
- `radar-market-reader-state`：阅读、补看、观察清单及内容禁区投影。
- `radar-market-agent-surface`：CLI/MCP、证据问答、任务恢复、观测与验证输出。

### Modified Capabilities

无。市场能力使用新合同，旧稳定 specs 不被改义；实现若发现必须改变旧合同，先补独立迁移设计。

## Impact

范围为 src/adapters、src/pipeline、src/db、src/app、src/mcp、CLI、调度及对应测试/文档，代码仍为 TypeScript/Bun＋Drizzle。不新增服务端、商业数据采购、聊天投递、影片下载或生产能力。

根交接：[radar-global-market-intelligence-v1](../../../../../openspec/changes/radar-global-market-intelligence-v1/design.md)。
DSH 消费者：[dsh-radar-market-intelligence-v1](../../../../../agent/harness-plugins/openspec/changes/dsh-radar-market-intelligence-v1/design.md)。
本 change 的实现任务目前均未完成；本次文档编辑不代表功能已实现。
