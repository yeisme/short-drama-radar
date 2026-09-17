## 1. 本地化目录采样

由 scripts/reelshort-localized-check.ts 生成。单 writer 串行交付，真实采样与隔离回归分别记录。

- [x] 1.1 实现本地化链接边界和原文标题；owner=radar；依赖=真实页面形态；验收=原文/编码链接去重、跨语言及外链拒绝、旧来源不变；验证=market-reelshort-localized 集成测试。
- [x] 1.2 接通 observe 与质量记录；owner=radar；依赖=1.1；验收=显式 live、生产资格门、未知字段、幂等和异常脱敏；验证=market-reelshort-localized 集成测试。
- [x] 1.3 真实 CLI 演练；owner=radar；依赖=1.2；验收=两来源真实样本、作品列表和简报读回，不提升 readiness；验证=bun run scripts/reelshort-localized-live.ts --confirm-live。
- [x] 1.4 软件收口；owner=radar；依赖=1.1–1.3；验收=typecheck、含真实 PG 的全量测试、strict OpenSpec、文档；验证=bun run scripts/reelshort-localized-check.ts --verify --live-home <directory>。

## 2. 验证依据

完整软件验证证据：temp/integration-test-runs/2026-09-17T02-12-46-147Z-n0sjpo。真实 CLI 目录回执：temp/reelshort-localized-live-r9BW0y。仅验证一次公开目录链路，不代表持续来源资格、市场热度或受众验证。
