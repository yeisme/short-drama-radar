# 日语／韩语公开目录真实采样

2026-09-17 已完成 ReelShort 日语页和韩语页的真实 CLI 验证采样。它们是面向相应语言的公开目录入口，不是日本／韩国本土作品榜，也不是已经完成形式核验的漫剧专用来源。

本次在独立本地研究库中完成注册、真实抓取、作品列表、分析、简报构建及读回。日语页得到 16 条、韩语页 15 条，共 31 条目录观测；来源 readiness 仍为 planned，作品 mapping 仍为 candidate，未写个人创作反馈或 used。

## 可复核结果

- [日语入口](https://www.reelshort.com/ja)：/ja/movie 路径含编码标题和稳定作品 ID。
- [韩语入口](https://www.reelshort.com/ko)：根 /movie 路径含韩文标题和稳定作品 ID。
- 真实 CLI 测试证据：`temp/integration-test-runs/2026-09-17T02-08-18-489Z-icld77/`。
- 研究库与逐步回执：`temp/reelshort-localized-live-r9BW0y/`；`report.json` 汇总本次样本、分析、作品和简报引用，`radar.db` 保留可继续检查的领域状态。

原始网页不进入数据库。回执只保留规范化公开作品事实；无登录、付费、账号读取或访问限制绕过。这个库用于隔离验证，没有修改用户默认 Radar 配置或关注。

## 现在能看什么

可以查看原文作品标题、可核对的作品链接及新出现的目录条目。仅依据目录顺序不会生成热度或排名；同一发布者的多语言目录不作为独立需求印证。

本次类别与集数字段均未取得可靠值，地区、作品形式、制作方式保持 unknown；来源语言不是国家受众证据。简报返回 degraded 是正确结果，不把未知补成零需求，也不自动升级来源来强行生成热门榜。

当前应按 `reelshort-ja`、`reelshort-ko` 来源阅读样本。JP/KR 地区关注不应强行包含 market=unknown 的作品，否则会把语言目录误报成国家市场情报。个人简报后续可按语言来源组织阅读版块，同时保持底层地区证据不变。

## 重跑真实链路

从 Radar 子项目目录运行：

```bash
bun run scripts/reelshort-localized-live.ts --confirm-live
```

脚本每次新建独立本地研究库，输出 home 和测试证据路径。不会自动注册到默认个人库、设置定时器、提升资格或产生付费请求。页面不可读、空数据或关键步骤失败时退出非零，保留已执行步骤供复核，不用 fixture 冒充成功。

读取本次已经生成的作品列表：

```bash
RADAR_HOME="$PWD/temp/reelshort-localized-live-r9BW0y" \
RADAR_DB_PATH="$PWD/temp/reelshort-localized-live-r9BW0y/radar.db" \
RADAR_CONFIG_PATH="$PWD/temp/reelshort-localized-live-r9BW0y/config.json" \
bun run src/cli.ts market work list --json
```

若决定在自己的常用 Radar 库中使用，已实现的显式入口如下；这些命令会注册来源并真正读取公开页面：

```bash
bun run src/cli.ts market init
bun run src/cli.ts market source register-candidate --source reelshort-ja --publisher-group reelshort --locale ja --market JP
bun run src/cli.ts market source register-candidate --source reelshort-ko --publisher-group reelshort --locale ko --market KR
bun run src/cli.ts market observe --source reelshort-ja --mode verify-sample --confirm-live
bun run src/cli.ts market observe --source reelshort-ko --mode verify-sample --confirm-live
```

这里的 --market 是候选来源的目标范围声明，不会把每条观测变成已知 JP/KR。production 模式继续受来源资格约束，不在这次验证中启用。

## 后续推进

先核验少量作品详情，取得形式、真实类别与可引用证据，再完善原文标签映射；同时寻找独立的日韩本地公开入口。连续采样与去重稳定后再考虑个人定时简报。目录接通不关闭原有持续资格、港台覆盖与个人使用回顾事项。

软件收口：类型检查通过；完整测试 370 项通过、零失败、零跳过，含真实 PostgreSQL。最终回归证据：`temp/integration-test-runs/2026-09-17T02-12-46-147Z-n0sjpo/`。对应 OpenSpec 已归档；源资格仍未升级。
