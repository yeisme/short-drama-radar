## ADDED Requirements

### Requirement: Layer 2 capability 必须由环境派生

`radar mcp capabilities` 与 `radar://capabilities` 的 `layer2_browser_fallback` 条目 SHALL 由实时就绪探针派生（playwright 模块可用、chromium 可执行文件已安装、账号池存在活跃账号、各活跃账号的凭据/代理描述符在 secret store 就位）。blocked 状态 MUST 携带具名 reasons 与 next_action；ready 状态 MUST NOT 出现在任一前置缺失时。已发布的 handoff fixture 快照保留未配置环境的 blocked 基线并注明派生语义。

#### Scenario: 未配置环境读取 capabilities
- **WHEN** 任何 lane 读取 `radar://capabilities` 且 chromium 未安装或账号池为空
- **THEN** layer2_browser_fallback 为 blocked 且 reasons 逐项命名缺失前置

#### Scenario: 完整配置环境读取 capabilities
- **WHEN** 模块、chromium、活跃账号与 secret store 全部就位
- **THEN** layer2_browser_fallback 报告 ready（真实可用性仍由首次真实 flow 与 canary 验证）
