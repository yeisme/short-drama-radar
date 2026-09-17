# radar-reelshort-localized-sampling Specification

## Purpose
为 Radar 个人使用提供日语、韩语公开目录的显式验证采样，复用作品、证据、质量和简报合同，并将语言入口与真实地区、形式、需求及持续来源资格严格区分。
## Requirements
### Requirement: 本地化目录身份与边界

Radar SHALL 对显式 reelshort-ja、reelshort-ko 来源支持同主机、对应语言或根路径作品链接，保留原文标题和稳定 ID；SHALL 拒绝其他语言前缀、外链、凭据和播放页面。旧来源解析保持兼容。

#### Scenario: 重复原文链接
- **WHEN** 同一作品通过原文和编码 URL 多次出现
- **THEN** 只形成一个目录条目，去除查询和 fragment，不推断题材或排名

### Requirement: 真实采样不自动取得资格

本地化 observe SHALL 复用显式 live 确认、fixture 隔离、production 资格和 blocked 拒绝门；采样后 SHALL 保留原有 readiness，记录固定页面及解析版本。

#### Scenario: 新候选验证
- **WHEN** planned 来源被显式进行 verify-sample
- **THEN** 可保存真实目录观测，但其地区、形式、需求与持续资格仍不得由目录语言推出

### Requirement: 可复核的真实链路

显式 live 演练 SHALL 通过 CLI 创建隔离研究库、注册并采样两种语言来源、保存规范回执，再运行分析、简报构建和读回。失败 SHALL 保留证据，不以 mock 或旧样本代替。

#### Scenario: 简报无足够可比信号
- **WHEN** 真实采样成功但证据不足以形成可比市场信号
- **THEN** 保留目录和诚实的简报状态，不为了生成非空排名而升级来源或捏造指标

