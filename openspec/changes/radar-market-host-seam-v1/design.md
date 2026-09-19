# Radar 市场 host seam（DSH owner host 服务）

## 1. 目标与消费者

为 DSH 客户端 `ui-personal-radar` 的市场 Pane 提供 Radar 侧 owner host 服务。消费者契约（只读参考，不在本仓修改）：

- `RadarMarketHostFace`（schema `dsh.radar.market-host.v1`）：contextRef/load/subscribeContext/subscribePolicy 必选；loadCatchup/loadSignal/loadEvidence/loadCompare/loadReviewIndex/loadReview/mutate/probeCapability 可选。
- 底层 `ConnectedMarketTransport.readResource({uri})` 读取 `radar://market/...` 资源，payload 解析按 `radar.market_*.v1` 规范（brief/signal/reader/catchup/compare/review/evidence/source_gaps/capabilities）。
- `radarHost.dispatch`（可选）提交 typed `dsh.radar.intent.v1` proposal intent，期望 `dsh.radar.receipt.v1` 回执并对账 `assignmentRef`；do_not_shoot 以 reason 文本识别。
- capability probe 只认 `{spec: "radar.market_capabilities.v1", views: string[]}`，required views 为 market_brief/market_reader。

本 change 交付 Radar 侧的传输与投影，DSH 侧 adapter（子进程拉起、readResource 映射）由 harness-plugins 后续对接；合同以 docs/interfaces/market-host-seam.md 为准。

## 2. 传输决策

选定方案：**本地 stdio host 循环**。新 CLI 子命令 `radar market host-serve`，stdin/stdout 换行分隔 JSON 帧，stderr 只走诊断（英文、无凭据）；DSH adapter 作为子进程拉起并持有生命周期。

理由：

- 单本地消费者、零网络监听、无常驻 daemon：帧循环随 stdin 关闭或 shutdown 帧结束，不需要端口、认证或多消费者治理。
- 与 DSH `readResource({uri})` 的资源语义一一映射：读帧请求 `radar://market/...` URI，响应帧携带 `{uri, text}`（text 为 payload JSON 字符串），DSH adapter 可直接包成 `{contents:[...]}` 复用既有 resourceData 解析。
- payload 复用现有 market 服务函数（经 marketCommand 路由），与 CLI `--json` 的 data 字节同源；policy、禁区、ref 安全校验与既有出口一致，不复制第二套投影逻辑。

否决的备选：

- 本地 HTTP 端口：引入监听面、端口冲突与多消费者治理，违反“不新增服务端”边界。
- 恢复 MCP stdio server：MCP 面已整体移除（5d8d78a），恢复将重建 tools/list/inputSchema 语义并与 CLI 消费收敛方向冲突。
- DSH 逐次执行一次性 CLI 命令并解析 stdout：无法承载 contextRef 绑定、订阅式失效与 pane 长驻读取，且每次冷启动成本高；CLI 消费合同保留给通用 Agent。

## 3. 帧协议（radar.market.host.frame.v1）

请求帧（stdin，每行一个 JSON 对象）：

```json
{"schema":"radar.market.host.frame.v1","id":1,"op":"read","uri":"radar://market/briefs/latest"}
{"schema":"radar.market.host.frame.v1","id":2,"op":"dispatch","intent":{"schema":"dsh.radar.intent.v1","kind":"proposal","opportunityRefs":["opp-1"],"editionRef":"edition-...","idempotencyKey":"...","confirmed":false}}
{"schema":"radar.market.host.frame.v1","id":3,"op":"lookup-receipt","idempotencyKey":"..."}
{"schema":"radar.market.host.frame.v1","id":4,"op":"shutdown"}
```

响应帧（stdout，每请求恰好一行，按请求 id 对应）：

```json
{"schema":"radar.market.host.frame.v1","id":1,"ok":true,"resource":{"uri":"radar://market/briefs/latest","text":"{\"spec\":\"radar.market_brief.v1\",...}"}}
{"schema":"radar.market.host.frame.v1","id":2,"ok":true,"receipt":{"schema":"dsh.radar.receipt.v1","idempotencyKey":"...","outcome":"submitted","reason":"assignment assignment-... created for Auctra ingress","assignmentRef":"assignment-..."}}
{"schema":"radar.market.host.frame.v1","id":3,"ok":true,"receipt":null}
{"schema":"radar.market.host.frame.v1","id":4,"ok":false,"error":{"code":"brief_not_found","message":"..."}}
```

约束：帧按接收顺序串行处理；stdout 不输出帧以外内容；畸形行返回 `{id:null, ok:false, error:{code:"frame_invalid"}}`，不中断循环；shutdown 帧返回 ack 后正常退出。

## 4. 读面映射

URI → 现有命令（payload = CommandResult.data）：

| URI | 路由 |
|---|---|
| radar://market/capabilities | 本地构建（spec=radar.market_capabilities.v1，views 声明下列已实现 view；recovery 指向 doctor 与 CLI 合同） |
| radar://market/reader | market reader show |
| radar://market/briefs/latest、briefs/{ref} | market brief show [--brief] |
| radar://market/signals/{ref}/revisions/{n} | market signal show --signal --revision |
| radar://market/signals/{ref}/revisions/{n}/evidence/{e} | market evidence show |
| radar://market/catchup[?cursor=&limit=] | market reader catchup |
| radar://market/coverage | market source gaps |
| radar://market/sources | market source list |
| radar://market/watches | market watch list |
| radar://market/watches/{ref}/changes[?since=&until=] | market watch changes |
| radar://market/reading[?language=&source=&limit=] | market reading list |
| radar://market/compare/{l}/{lr}/{r}/{rr} | market compare |
| radar://market/reviews | 有界 review index（最近 30 条摘要，复用 marketReviews 表） |
| radar://market/reviews/{ref} | market review show |
| radar://market/question?signal=&revision=&question= | market question context |

规则：路径段必须匹配安全 ref 字符集；signal 读取必须绑定 revision，缺失返回具名 not_found，不回退最新；catchup 游标语义与 CLI 相同（state_conflict/cursor_invalid 具名错误）；watch changes 窗口默认最近暂停期或 30 天，与 CLI 一致。

## 5. typed dispatch

仅接受 `dsh.radar.intent.v1` kind=proposal（opportunityRefs 0–1 个安全 ref、editionRef 可选、idempotencyKey 安全 ref、confirmed 布尔）；其他 kind 或结构非法返回具名错误帧，不落任何写入。

映射：owner 本地 `createAssignment(db, {profile, editionRef, opportunityRef, idempotencyKey})`。

- ready → 回执 outcome=submitted，reason 含 assignment ref，附 assignmentRef。
- do_not_shoot（空榜/不达标）→ outcome=rejected，reason 明示 do_not_shoot，不伪装成功。
- 同键同参重放 → createAssignment 幂等复用原 assignment，回执与首次一致（幂等重放返回原回执）。
- 同键异参 → idempotency_conflict 错误帧。
- 无 active profile → profile_required 错误帧。
- `lookup-receipt`：按原键查询 radarAssignments，命中返回 outcome=reconciled 回执（附 assignmentRef），未命中返回 `receipt:null`；绝不二次 dispatch。

reader/watch 写入（mark/unread/watch add 等）不进入 dispatch：外部消费端的显式写入按 agent-cli-consumption 合同由用户确认后经 owner CLI 执行。

## 6. 安全与边界

- 所有读取复用既有服务函数：禁区（blocked topics/未知分类）在每个出口执行，受滤内容不复述；brief/catchup 的 ready/empty/degraded 与 source_gap 诚实呈现。
- 帧内不出现原始 HTML、快照 payload、凭据、cookie、绝对路径或 public URL；question context 沿用 10×500 有界摘要。
- 禁止：浏览器侧启动 Radar CLI 或 host-serve、读 SQLite 直连、维护第二份 Profile/Edition/阅读真源、把缓存当实时数据。
- 错误码直接复用 MarketStoreError.code（brief_not_found、signal_not_found、evidence_not_found、review_not_found、content_blocked、state_conflict、cursor_invalid、idempotency_conflict、profile_required 等），帧错误 message 为脱敏英文。

## 7. 测试与证据

- 单元（test/unit/market-host-serve.test.ts）：帧解析与错误帧、URI 路由、ref 安全校验、dispatch 幂等/冲突/do_not_shoot、lookup 对账、policy 拒绝路径（内存库 + 注入流）。
- 集成（test/integration/market-host-seam.test.ts）：真实子进程 stdio 帧回放——market init → import-catalog（fixture）→ analyze → brief build → profile create → run（fixture）后：capabilities/reader → brief 读取 → coverage 缺口 → catchup 翻页（两页+末页）→ dispatch（submitted）→ 同键重放原回执 → lookup-receipt → 禁区 content_blocked 拒绝路径；经 scripts/integration-test-run.ts 留 run 目录证据。
- 门禁：bun run typecheck、bun test、openspec validate radar-market-host-seam-v1 --strict --no-interactive 全绿后归档。
