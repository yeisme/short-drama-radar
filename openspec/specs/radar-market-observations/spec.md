# radar-market-observations Specification

## Purpose
TBD - created by archiving change radar-hongguo-catalog-parsing-v1. Update Purpose after archive.
## Requirements
### Requirement: 红果目录 anchor 结构必须确定性拆分
hongguo HTML 解析 MUST 用显式版本化规则 `hongguo-anchor-layout.v1` 识别「标题连续重复两次后接题材标签串」的 anchor 文本，拆出干净 title 与标签串；标签串 MUST 去重且每个 anchor 最多绑定 8 个标签。结构识别失败时 MUST 保留原文 title 且不产出任何标签，MUST NOT 半拆或猜测。该规则 MUST 只作用于 hongguo HTML 解析路径，reelshort/dramabox/markdown 解析行为 MUST NOT 改变。

#### Scenario: 粘连标题拆分
- **WHEN** anchor 文本为 `夺风华夺风华古装重生逆袭日久生情`
- **THEN** title 为 `夺风华`，题材标签为 `古装`、`重生逆袭`、`日久生情`，title 不含重复串

#### Scenario: 结构不匹配回退
- **WHEN** anchor 文本中标题只出现一次或无法确定性划分标签串
- **THEN** title 保持原文清洗结果，标签为空，不报错、不猜题材

### Requirement: 题材标签必须来自页面结构与版本化映射
作品题材标签 MUST 仅来自页面自身结构（anchor 标签串或 section heading）并经当前版本化映射 `market-label-mapping.v1` 的 `classifyLabels` 消费；映射表未覆盖的标签 MUST 保留原文于 evidence `category_label` 且 topics 留空。anchor 自带标签串与 section heading 同时存在时 MUST 采用 anchor 自带标签；两者均缺失时 category 保持 null。MUST NOT 用关键词匹配标题或剧情文本推断题材。

#### Scenario: 映射命中的标签
- **WHEN** 拆分得到的标签在 zh 映射表中有词条
- **THEN** 观测 topics 含映射后 topic，evidence 保留原始标签

#### Scenario: 未映射标签
- **WHEN** 拆分得到的标签不在映射表中
- **THEN** topics 为空，原始标签文本保留在 evidence，不降级为猜测分类

### Requirement: 跳过链接归因必须可解释
目录解析回执 MUST 保持 `skipped_links.foreign_or_unsafe_link` 与 `skipped_links.no_work_identity` 计数，并 SHALL 在 limitations 中给出跳过链接的归因分类摘要（如导航/播放/登录隐私等非作品页、外链）；同 host 非作品页链接 MUST NOT 计为 `foreign_or_unsafe_link`，异 host/非 https/带凭据链接 MUST NOT 计为 `no_work_identity`。回执与日志 MUST NOT 回显完整可疑 URL。若复核发现作品链接身份提取缺陷，修复 MUST 给出修复前后跳过数对比。

#### Scenario: 非作品页链接跳过
- **WHEN** 目录页含导航、播放页、登录/隐私等同 host 链接
- **THEN** 计入 `no_work_identity`，limitations 含归因分类摘要，不产出观测

#### Scenario: 外链与不安全链接
- **WHEN** 目录页含异 host、明文 http 或带凭据的链接
- **THEN** 计入 `foreign_or_unsafe_link`，不产出观测，日志不回显完整 URL

### Requirement: 解析修正必须兼容存量观测
已入库的观测与 evidence payload MUST 保持不可变，解析规则变更 MUST NOT 改写历史记录。清洗后的数据 MUST 通过 owner 显式 `--confirm-live` 重采样生成新 batch/观测 revision 入库；同一 `series_id` 的 candidate work mapping SHALL 通过 `refreshWorkCandidate` 产生新 revision 更新标题，旧 revision 保留可回查，verified mapping MUST NOT 被自动降级。`--fixture` 验证 MUST 保持 origin=fixture，不与 live 数据混淆。

#### Scenario: 重采样更新候选映射
- **WHEN** 解析修正后对红果重采样且同一 `series_id` 标题由粘连变为干净
- **THEN** 产生新 batch 与新 mapping revision，2026-09-16 旧观测与证据原样可读

#### Scenario: 已验证映射不被降级
- **WHEN** 重采样命中一个 owner 已 review 为 verified 的 mapping
- **THEN** mapping_status 保持 verified，旧 revision 不变

