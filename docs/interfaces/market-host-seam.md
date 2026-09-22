# Radar 市场 host seam 合同（radar-market-host-seam-v1）

面向 DSH 客户端 `ui-personal-radar`（`dsh.radar.market-host.v1` host 契约）的 Radar 侧 owner host 服务。DSH adapter 作为子进程拉起本命令并通过 stdio 帧通信；常规 Agent 交互仍走 [agent-cli-consumption](./agent-cli-consumption.md) 的 CLI 消费合同，两个合同互不替代。

## 启动与生命周期

```bash
bun run src/cli.ts market host-serve     # 或已安装的 radar market host-serve
```

- stdin/stdout：换行分隔 JSON 帧（NDJSON），一请求一响应，按到达顺序串行处理。
- stderr：仅诊断（英文、脱敏）；stdout 除帧外没有任何输出（命令结束也不打印 envelope）。
- 结束：stdin 关闭或收到 `shutdown` 帧即退出；无网络监听、无常驻 daemon、单本地消费者。
- 由消费者（DSH adapter）负责拉起与结束；浏览器侧不得启动本命令。

## 帧 schema（radar.market.host.frame.v1）

请求：

```json
{"schema":"radar.market.host.frame.v1","id":1,"op":"read","uri":"radar://market/briefs/latest"}
{"schema":"radar.market.host.frame.v1","id":2,"op":"dispatch","intent":{"schema":"dsh.radar.intent.v1","kind":"proposal","opportunityRefs":["opp-1"],"editionRef":"edition-...","idempotencyKey":"dsh-key-1","confirmed":false}}
{"schema":"radar.market.host.frame.v1","id":3,"op":"lookup-receipt","idempotencyKey":"dsh-key-1"}
{"schema":"radar.market.host.frame.v1","id":4,"op":"shutdown"}
```

响应：

```json
{"schema":"radar.market.host.frame.v1","id":1,"ok":true,"resource":{"uri":"radar://market/briefs/latest","text":"{\"spec\":\"radar.market_brief.v1\",...}"}}
{"schema":"radar.market.host.frame.v1","id":2,"ok":true,"receipt":{"schema":"dsh.radar.receipt.v1","idempotencyKey":"dsh-key-1","outcome":"submitted","reason":"assignment assignment-... created for Auctra ingress","assignmentRef":"assignment-..."}}
{"schema":"radar.market.host.frame.v1","id":3,"ok":true,"receipt":null}
{"schema":"radar.market.host.frame.v1","id":0,"ok":false,"error":{"code":"brief_not_found","message":"..."}}
```

- `id`：请求原样回显；畸形行（非 JSON、schema 不符、op 未知）返回 `id:null` 的 `frame_invalid`，不中断循环。
- `resource.text`：payload JSON 字符串，与对应 CLI `--json` 的 `data` 同源；DSH 侧可直接包成 `{contents:[{uri,text}]}` 供既有 resourceData/projection 解析。
- `error.code`：稳定具名码，复用 CLI 错误合同（见下）。

## 读面（op=read）

| URI | 对应 CLI | payload spec |
|---|---|---|
| `radar://market/capabilities` | —（本地构建） | `radar.market_capabilities.v1` |
| `radar://market/reader` | `market reader show` | `radar.market_reader.v1` |
| `radar://market/briefs/latest`、`radar://market/briefs/{ref}` | `market brief show [--brief <ref>]` | `radar.market_brief.v1` |
| `radar://market/signals/{ref}/revisions/{n}` | `market signal show`（revision 必填，缺失 `signal_not_found` 不回退最新） | `radar.market_signal.v1` |
| `radar://market/signals/{ref}/revisions/{n}/evidence/{evidence}` | `market evidence show` | evidence 投影 |
| `radar://market/catchup[?cursor=<cursor>&limit=1-100]` | `market reader catchup` | `radar.market_catchup.v1` |
| `radar://market/coverage` | `market source gaps` | `radar.market_source_gaps.v1` |
| `radar://market/sources` | `market source list` | sources 列表 |
| `radar://market/watches` | `market watch list` | watches+reader |
| `radar://market/watches/{ref}/changes[?since=&until=]` | `market watch changes` | `radar.market_watch_changes.v1` |
| `radar://market/reading[?language=zh-Hans|zh-Hant&source=&limit=1-100]` | `market reading list` | 中文阅读层投影 |
| `radar://market/compare/{left}/{lr}/{right}/{rr}` | `market compare` | `radar.market_cross_market.v1` |
| `radar://market/reviews` | —（有界索引，最近 30 条摘要） | `radar.market_reviews.v1` |
| `radar://market/reviews/{ref}` | `market review show` | `radar.market_review.v1` |
| `radar://market/question?signal=&revision=&question=` | `market question context`（question 1–2000 字符） | question context 投影 |

`capabilities.views` 声明 seam 实际提供的 view 名（`market_brief`、`market_reader` 为 DSH required）；recovery 指向 `radar doctor --json`。查询参数只允许表中列名、各至多一个；路径段必须匹配 `[A-Za-z0-9][A-Za-z0-9._:-]{0,159}`，否则 `resource_not_found`/`input_invalid`。

## dispatch 与对账

- 只接受 `dsh.radar.intent.v1` 且 `kind=proposal`：`opportunityRefs` 0–1 个安全 ref、可选 `editionRef`、必填 `idempotencyKey`（安全 ref）、`confirmed` 布尔。`confirmed` 是主机侧"用户已在 DSH 界面确认"的声明，仅作审计字段——它不构成 Radar 侧门禁，`false` 不拦截 dispatch（Radar 自己的 ready/stale/幂等门才是权威）；reader/watch 类写入仍要求主机在用户明确确认后走 owner CLI。其他 kind 返回 `intent_unsupported`，结构/内容不安全返回 `intent_invalid`/`intent_unsafe`，均零写入。
- 映射 owner 本地 `createAssignment`：
  - ready → 回执 `outcome=submitted`，含 `assignmentRef`；
  - 空榜/不达标 → `outcome=rejected`，reason 明示 `do_not_shoot`；
  - 同键同参重放 → 返回原回执（同 `assignmentRef`）；
  - 同键异参 → `idempotency_conflict`；
  - 无 active profile → `profile_required`。
- `lookup-receipt`：按原键查询 assignment，命中返回 `outcome=reconciled` 回执，未命中返回 `receipt:null`；绝不二次 dispatch。
- reader/watch 写入（mark/unread/watch add/pause/resume/remove）不在 seam 内：外部消费端按 CLI 消费合同在用户明确确认后于 owner CLI 执行。

## 错误码

复用既有稳定码：`brief_not_found`、`signal_not_found`、`evidence_not_found`、`review_not_found`、`content_blocked`、`state_conflict`、`cursor_invalid`、`idempotency_conflict`、`profile_required`、`resource_not_found`、`input_invalid`、`frame_invalid`、`intent_unsupported`、`intent_invalid`、`intent_unsafe`、`value_required`、`command_unknown`。message 为脱敏英文。

## 边界与禁止

- 帧与诊断不携带原始 HTML、快照 payload、凭据、cookie、token、绝对路径或 public URL；question context 沿用 10×500 有界摘要。
- 禁区（blocked topics/未知分类）在每个读出口执行，受滤内容不复述；`degraded`/`empty`/`source_gap` 诚实呈现。
- 禁止：浏览器侧启动 Radar CLI 或 host-serve、直连/复制 Radar SQLite、维护第二份 Profile/Edition/阅读真源、把缓存当实时数据。
- DSH 侧 adapter（子进程拉起、readResource→帧映射、subscribeContext/subscribePolicy 桥接）由 harness-plugins 依据本文件对接；真实 DSH 会话接入状态以 DSH 侧验收为准，不由本合同推断。
