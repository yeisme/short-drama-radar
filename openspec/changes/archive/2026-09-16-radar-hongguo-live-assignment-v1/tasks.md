## 1. 红果 live observe

- [x] 1.1 内化 ingestCatalog，允许 origin=live；公开 importCatalog 拒绝 live；owner=radar；验证=bun test test/unit/market-adapters.test.ts
- [x] 1.2 实现 hongguo observe（verify-sample/production 门、--confirm-live/--fixture、Firecrawl 固定目录页、空页失败）；owner=radar；验证=bun test test/unit/market-observe.test.ts
- [x] 1.3 接通 CLI `market observe` 与 usage；其他来源仍拒绝；owner=radar；验证=bun test test/unit/market-cli.test.ts

## 2. assignment

- [x] 2.1 增加 radar_assignments 表（Drizzle + migrate）；owner=radar；验证=打开新旧库
- [x] 2.2 实现 assignment create/show/reject（stale、空榜、幂等、反馈）；owner=radar；验证=bun test test/unit/assignment.test.ts
- [x] 2.3 接通 CLI `assignment create|show|reject`；owner=radar；验证=同上 + typecheck

## 3. 文档与回归

- [x] 3.1 更新 docs/product/global-market-radar.md 与 README observe/assignment 状态
- [x] 3.2 bun test 与 bun run typecheck；openspec validate --strict。证据：2026-09-15 bun test 239/239、typecheck 0、openspec validate radar-hongguo-live-assignment-v1 --strict 通过。真实红果 7 日资格与 Auctra ingress 仍外部门。

## 4. Auctra submit

- [x] 4.1 assignment submit：调用 Auctra from-radar，成功后 submitted + used；失败不写 used；owner=radar；验证=bun test test/unit/assignment.test.ts
- [x] 4.2 CLI `assignment submit --auctra-path`；owner=radar；验证=同上 + typecheck。证据：2026-09-15 bun test 241/241、typecheck、openspec strict 通过。

## 5. Scaena 建项

- [x] 5.1 assignment produce：Auctra accepted 后调用 Scaena radar import；owner=radar；验证=bun test test/unit/assignment.test.ts
- [x] 5.2 CLI `assignment produce --scaena-path`；owner=radar；验证=同上 + typecheck。证据：2026-09-15 bun test 241/241；scaena go test handoff/cli Radar|Handoff。
