# Tasks

- [x] 1.1 从 MCP discovery/dispatch 移除 `collect`、`daily_run`。
- [x] 1.2 为剩余本地写操作增加显式 operator profile。
- [x] 1.3 增加重连、unknown call 和零副作用测试。
- [x] 1.4 运行 Radar MCP integration tests。
- [x] 1.5 同步 handoff fixtures（operator lane/external_side_effect_actions/cli_only_actions）、README 与 mcp-cli-interaction 文档，并把 handoff 偏差测试升级为对 `mcpActionAllowed` 实际 dispatch 面断言。
- [x] 1.6 `radar://sources/status` 改为本地状态 + 最近采集回执（零网络/平台后端副作用）；`radar doctor` 的 firecrawl 探测改为 GET 可达性（不再消耗抓取配额）。
