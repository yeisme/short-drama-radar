# Radar Layer 2 浏览器兜底解锁

## Why

capability 表把 `layer2_browser_fallback` 硬编码为 blocked，next_action 只说 "bun add playwright + add account descriptors"——真实缺口远不止依赖：`credentialRef` 没有任何读取路径（`newContext` 从不注入登录态，账号实际以匿名上下文运行）；`proxyRef` 是占位（opaque ref 直接被当作 proxy server URL 传给 chromium，任何带代理的账号 launch 必失败）；`config.accountPool` 的配额配置无消费者（browser.ts 硬编码 200）。

## What Changes

- **secret-store 桥**（新 `src/adapters/secrets.ts`）：`~/.config/short-drama-radar/secrets/<credentialRef>.json`（Playwright storageState 格式）与 `<proxyRef>.json`（{server,username?,password?}）；强制 0600；内容绝不入日志/证据/DB（错误只引用 ref 与路径）；`RADAR_SECRETS_DIR` 可覆盖
- **launchPlaywright**：解析凭据与代理在任何浏览器启动之前——缺失即显式降级带修复提示，绝不匿名上下文、绝不静默直连；登录态经 `newContext({ storageState })` 注入
- **playwright 转为硬依赖**（npm 包，不含浏览器二进制）；doctor 的 playwright 检查升级为 模块+chromium 可执行文件（缺失=degraded + `bunx playwright install chromium`）
- **capabilities 派生**：`layer2_browser_fallback` 由 `probeLayer2`（模块+chromium+账号池+secret store 就绪）实时派生 {status, reasons[], next_action}；fixtures 快照保留 blocked 作为参考环境基线并注明派生语义
- **配额接线**：`config.accountPool.dailyQuotaPerAccount` 经 AdapterContext 进入 browser adapter（原 200 硬编码）；删除无消费者的 per-platform 计数
- **能力上限显式化**：L2 抽取 metrics={}、confidence≤50——degraded 兜底而非一等证据，不伪造数字

## Impact

新增依赖 `playwright@^1.63`（约 8MB 驱动，无浏览器下载；测试全 mock 保持离线可测）；`radar mcp capabilities` 与 `radar://capabilities` 的 layer2 条目变为环境派生（payload 只增 reasons 字段）；chromium 二进制与真实登录态仍属用户侧外部门控。

## Deferred

- 真实登录态导出与 14 天 canary（用户侧）
- L2 flow 的互动指标抽取（需真实页面结构验证，canary 期间观察）
