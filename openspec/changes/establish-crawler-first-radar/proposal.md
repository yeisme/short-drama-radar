# 建立爬虫主路的短剧爆款雷达 CLI

## Why

个人短剧创作者需要稳定取得可追溯的公开市场信号，作为后续个人化机会判断的证据底座。官方开放平台均无全平台热榜能力（抖音仅授权账号数据、小红书公开入口偏电商），因此以爬虫为主路、第三方数据作交叉校验。

## What Changes

- 新建 `short-drama-radar` Bun CLI：四层采集（firecrawl 公共页 / agent-reach 平台后端 / Playwright 兜底 / 人工导入）、SQLite 快照与去重、v0 评分（0.40 传播增速 + 0.25 题材频次 + 0.20 钩子密度 + 0.15 情绪强度，confidence < 60 转人工）、`short-drama-radar.card.v1` 卡片合同输出。
- 账号池+代理池轮换与熔断降级（不自动绕过验证码）。
- 集成测试证据写入 `temp/integration-test-runs/`。
- 本变更只建立公共采集/证据/基础评分与兼容卡片；Profile、反馈、机会簇、Morning Edition、CLI/MCP/Hermes 进入 `personalized-radar-agent-experience-v1`。

## Impact

- 影响面：仅本子项目；`short-drama-radar.card.v1` 保持兼容，任何外部投递消费者另行立项。
- 风险：平台风控导致账号封禁；采集健康是个人化 Edition 的前置证据门，但不等同于个人化产品验证。

## 依据

Root 批准计划：《短剧爆款雷达 · 爬虫主路采集方案》（2026-08-29）。
