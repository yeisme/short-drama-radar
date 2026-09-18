# radar-market-agent-surface Delta

## ADDED Requirements

### Requirement: 目录回执必须显式报告字段覆盖与跳过归因
`radar market observe` 与 `radar market import-catalog` 回执 MUST 继续以 `field_coverage`（按有题材标签的作品计数 category、按有显式集数文本的作品计数 episode_count）与 `skipped_links` 呈现部分失败，MUST NOT 把缺失字段隐含为成功覆盖；解析修正后回执 limitations SHALL 说明标签来源（anchor 结构规则版本 `hongguo-anchor-layout.v1` 或 section heading）与跳过归因摘要。命令名、envelope、agent/events/explain 渲染与既有 CLI 输出合同 MUST NOT 改变。

#### Scenario: 覆盖率与跳过数可见
- **WHEN** fixture 回放解析修正后的红果夹具
- **THEN** 回执 `field_coverage.category` 接近全量（仅结构性无标签项除外），`skipped_links` 计数与 limitations 归因摘要同时存在

#### Scenario: 来源资格不被解析修正晋级
- **WHEN** 解析修正完成且 observe 成功
- **THEN** hongguo readiness 保持原值（planned），回执 `readiness_unchanged` 如实呈现，不输出晋级暗示
