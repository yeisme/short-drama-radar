# 实施与验收任务

由 scripts/openspec-tasks.py 维护状态。

- [x] 1.1 修复/实现合同与入口；focused tests 通过 | evidence: 新增 sdk-http bridge 与明确 CLI 参数；本仓 tarball/lock 固定 SDK，历史 fixture 保留；endpoint/model/mode 缓存隔离；SDK input digest 独立记录。
- [x] 1.2 完成 mock 联调、兼容/安全回归与质量门 | evidence: 显式 RADAR_JUDGMENT_ADAPTER_TEST_BIN mock 系统场景通过，6 answers/replay 零网络/fixture 与 mode 隔离/认证拒绝；全套 418 pass/1 PG skip/0 fail；temp/integration-test-runs/2026-09-21T14-37-48-534Z-zmzbhp/summary.json；bun run typecheck 与 bun install --frozen-lockfile 通过。
- [x] 1.3 更新文档、证据与真实 readiness | evidence: openspec validate radar-judgment-sdk-http-bridge-v1 --strict --no-interactive 与 git diff --check 通过；docs/product/reading-judgment.md、CLI help、vendor README 更新；本轮无真实凭据/付费请求。
