# short-drama-radar

短剧爆款雷达：爬虫主路的每日短剧选题情报 CLI。每天从抖音/小红书四层采集候选内容，快照入库、去重、打标签、评分，输出 Top5+Top5 卡片合同 payload 交给“云婉”投递。

## 快速开始

```bash
bun install
bun run src/cli.ts doctor            # 检查 firecrawl / agent-reach / db
bun run src/cli.ts run --json        # 完整日流水线：collect -> score -> card
```

离线冒烟（不碰真实平台）：

```bash
RADAR_FIXTURE_DIR=test/fixtures bun run src/cli.ts run --json
```

## 采集分层

1. Layer 0：自托管 Firecrawl 抓公共热榜/发现页（免登录，基线覆盖）。
2. Layer 1：agent-reach 小红书后端 + 抖音签名调用层（登录态，主信息源；未就绪时降级）。
3. Layer 2：Playwright 受控浏览器兜底，账号池轮换 + 熔断。
4. Layer 3：人工截图/CSV 导入。

规则：不自动绕过验证码与风控；账号池耗尽即降级出卡并在卡片明示。

## 输出合同

`radar card` 输出 `short-drama-radar.card.v1` payload：date、sourceStatus、trends、top.douyin(Top5)、top.xiaohongshu(Top5)，每条含 score 0-100、confidence、isNew、tags、url、degraded。云婉消费该合同做飞书卡片投递。

## 测试

```bash
bun test
bun run test:integration
bun run typecheck
```

规则与边界详见 [AGENTS.md](./AGENTS.md)。
