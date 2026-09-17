## Why

用户要求个人版日韩真实对接。现有 JP/KR 候选与关注只能记录意向，无法解析日文路径、韩文作品 slug，也没有这两个页面的 live 验证入口。真实公共页面已读取，发现日文 /ja/movie 与韩文 /movie 链接形态。

## What Changes

- 新增显式 reelshort-ja、reelshort-ko 解析和 observe 验证入口，复用现有 Firecrawl、观测、证据与质量记录。
- 保留原文标题，去除已观察到的日文“全シリーズ”导航后缀；不将推荐分区标题猜成题材，不从语言推断地区、形式或热度。
- 保留来源 planned、显式 live 确认与 production 资格门；默认初始化不自动新增来源或启用采集。
- 增加离线回归和显式 live CLI 演练脚本，留存独立研究库、回执和简报读回结果。

## Capabilities

### New Capabilities

- `radar-reelshort-localized-sampling`: 日语韩语公开目录采样。

### Modified Capabilities

无。旧 hongguo、reelshort、dramabox 解析及输出合同保持。

## Impact

fit owner 为 Radar。加法适配器与命令参数选项，无新增数据表、API 或依赖。不招募、不部署、不绕过访问限制、不购买内容。作品地区与形式保持 unknown，不能声称日本／韩国本地热榜或动画供给已接入。
