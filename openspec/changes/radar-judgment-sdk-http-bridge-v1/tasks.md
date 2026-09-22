# 实施与验收任务

由 scripts/openspec-tasks.py 维护状态。

- [x] 1.1 修复/实现合同与入口；focused tests 通过 | evidence: 新增 sdk-http bridge 与明确 CLI 参数；本仓 tarball/lock 固定 SDK，历史 fixture 保留；endpoint/model/mode 缓存隔离；SDK input digest 独立记录。
- [x] 1.2 完成 mock 联调、兼容/安全回归与质量门 | evidence: 显式 RADAR_JUDGMENT_ADAPTER_TEST_BIN mock 系统场景通过，6 answers/replay 零网络/fixture 与 mode 隔离/认证拒绝；全套 418 pass/1 PG skip/0 fail；temp/integration-test-runs/2026-09-21T14-37-48-534Z-zmzbhp/summary.json；bun run typecheck 与 bun install --frozen-lockfile 通过。
- [x] 1.3 更新文档、证据与真实 readiness | evidence: openspec validate radar-judgment-sdk-http-bridge-v1 --strict --no-interactive 与 git diff --check 通过；docs/product/reading-judgment.md、CLI help、vendor README 更新；本轮无真实凭据/付费请求。
- [x] 1.4 review 修复波：wire cap 预检+envelope headroom、非 ASCII id 桥接映射与结果回映、discovery 失败降级 not_submitted、evaluate 调用计数含 unknown、并发同 key 串行化、precheck 拒绝重放、status 真实计数、字节帽改真实 UTF-8 字节 | evidence: test/unit/reading-judgment-bridge.test.ts 9 断言组；全仓 441 pass/0 fail + typecheck 通过；SDK checkRequestBounds 对 canonicalJson(req.wire).length 施加请求自声明 max_input_bytes（vendor 包 validate.ts 实证），inline 预算内投影曾因 envelope 超限被拒并误报 invalid_request。
