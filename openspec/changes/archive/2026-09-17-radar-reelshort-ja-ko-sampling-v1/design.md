## Context

本轮通过 Firecrawl 真实读取日语／韩语公开页。现有 parser 只允许英文根路径；新页面出现 percent-encoded 日文与韩文 slug。采样范围是这两个语言目录当次可见的作品链接，不是完整平台目录。

## Decisions

沿用来源候选注册，不修改默认来源种子。reelshort-ja、reelshort-ko 对应固定 HTTPS 白名单页面；解析只接受同 host 的 /movie 或对应语言 /ja/movie、/ko/movie 路径及末尾 24 位作品 ID。其他语言前缀、外链、含凭据 URL 和播放页不入库；清除 query/hash 后持久化公开作品链接。

仅新来源启用 Unicode/percent-encoded slug，旧解析合同不放宽。标题保留原文，仅日语导航后缀在对应 source 下剥离。新来源不继承 section heading 为 genre，避免把“推荐”当题材。集数、类别、形式、制作方式、国家和受众指标没有足够依据就保持未知；不制造 rank。

复用 observe --mode verify-sample --confirm-live 与既有 HTTP 服务；验证模式不提升 readiness，production 继续要求资格。新源要求匹配语言和 reelshort publisher group，两种译配入口不构成独立发布者。质量记录使用 reelshort-localized-links.v1，不改写旧回执。

保留原文作品、来源回执与 source-level 可读列表。因为地区仍未知，不能强行把观测塞进 JP/KR 地区关注结果；暂按来源阅读。真实 CLI 演练在新建 temp 本地库完成，保留各步骤输出与 report；不修改用户默认 Profile、关注或反馈。

网络提供方异常只输出稳定错误，避免私有请求上下文进入回执。新增 live 演练须显式 --confirm-live；默认离线测试注入 provider fixture，不可把其 live 分支测试当作真实采样证据。

## Verification

测试覆盖链接边界、重复链接、导航后缀、原文身份、未知字段、描述符不匹配、资格门、幂等、fixture/live 入口区分、质量记录与异常脱敏。真实调用 CLI 执行注册、两来源 observe、work list、analyze、brief build/show 读回。软件最终验证复用 typecheck、现有带真实 PG 的全量测试及 strict OpenSpec。

若真实访问失败，保留失败证据，不退化为 fixture 成功；可读目录样本不是持续七日资格，也不是市场需求验证。无需自动晋级作品 mapping 或来源 readiness 才能查看样本。
