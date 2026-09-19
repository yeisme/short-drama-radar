## Why

DSH 客户端 `ui-personal-radar`（agent/harness-plugins/packages/client/ui-personal-radar）已按 `dsh.radar.market-host.v1` host 契约（contextRef/load/subscribeContext/subscribePolicy，可选 radarHost.dispatch typed proposal）实现市场 Pane，但目前只有合成 host 回放，没有 Radar 侧 owner host 服务。MCP 面已于 2026-09-15（5d8d78a）整体移除，Agent 的常规交互合同是 CLI 消费（docs/interfaces/agent-cli-consumption.md）；但 DSH Pane 需要 contextRef 绑定、持续读取与订阅式失效通知，一次性 CLI 命令无法承载该形状。需要一个由 DSH adapter 作为子进程拉起的本地 stdio host seam，帧内容复用现有 market 服务函数产出的安全投影。

## What Changes

- 新增 CLI 子命令 `radar market host-serve`：stdin/stdout 换行分隔 JSON 帧（schema `radar.market.host.frame.v1`），stderr 只走诊断；无网络监听、无常驻 daemon、单本地消费者，进程生命周期由消费者管理。
- 只读帧覆盖：capabilities、reader、latest brief / brief 指定版次、signal revision 详情、source coverage gaps、watch list + watch changes、catchup 分页（owner 游标）、reading list、compare、review index / review 指定 ref、evidence 指定 ref、question context；payload 与 CLI `--json` 的 data 同源。
- dispatch 仅接受 typed `dsh.radar.intent.v1` kind=proposal，映射 owner 本地 createAssignment；幂等重放返回原回执，`lookup-receipt` 按原键对账；空榜/不达标诚实返回 do_not_shoot。
- 禁区与 blocked topics 在所有帧出口继续执行；degraded/empty 诚实呈现；帧不携带原始 HTML、凭据或文件路径。
- 新增 seam 合同文档 docs/interfaces/market-host-seam.md 供 DSH 侧对接。

## Capabilities

### New Capabilities

- `radar-market-host-seam`: 本地 stdio host seam 的传输、读投影、typed dispatch 与错误合同。

### Modified Capabilities

无。CLI 现有命令、envelope、card/edition 合同不变；`agent-cli-consumption` 的 Agent CLI 消费合同不变，host seam 是 DSH 专用 owner 服务面，不向通用 Agent 开放。

## Impact

fit owner 为 Radar。新增 src/market/host-serve.ts、src/market/cli.ts 的 host-serve 路由、src/cli.ts help 行、test/unit/market-host-serve.test.ts、test/integration/market-host-seam.test.ts 与 docs/interfaces/market-host-seam.md。不新增数据表、依赖、网络监听或常驻服务；不修改 Profile/Edition 真源；禁止浏览器侧启动 Radar CLI、读 SQLite 直连、第二份 Profile/Edition 真源、原始 HTML/凭据入帧。真实 DSH 会话接入属于外部门，本 change 只交付 Radar 侧软件面。
