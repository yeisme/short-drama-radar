# radar-observation-quality-metrics Specification

## Purpose
持久化观测字段覆盖与跳过归因，支持质量回顾并保留缺数据语义。
质量指标与原始观测同事务保存，旧记录保持不变，未知字段不能被解释为业务机会不存在。

## Requirements
### Requirement: 每次观测必须持久化解析质量记录
observe 与 import-catalog MUST 在写入观测批次的同一事务写入 `radar.observation_quality.v1` 质量记录，与批次一对一，至少含 source_ref/revision、observed_at、origin、parser_version、逐字段 field_coverage（present/total）与 skipped 归因计数（foreign_or_unsafe_link/no_work_identity/title_invalid）。批次重放 MUST 复用原质量记录不重复写入；记录不可变，MUST NOT 含原始页面内容、凭据或本地路径。历史无记录的批次 MUST NOT 回填。

#### Scenario: 同一批次重放
- **WHEN** 相同内容的目录批次再次导入
- **THEN** 复用原批次与原质量记录，质量记录计数不变

#### Scenario: 部分字段缺失
- **WHEN** 批次内部分作品缺 category 或 episode_count
- **THEN** 质量记录如实反映较低覆盖率，不隐含或补齐字段

### Requirement: health 报告必须包含市场观测质量段
`radar health` MUST 在市场观测存在时输出逐来源质量段：窗口内字段覆盖率首末对比、skip 率趋势与批次计数。与前一等长窗口相比覆盖率下降超过版本化阈值 MUST 标 `regression_flagged` 作为可见告警，MUST NOT 作为构建或命令失败门。窗口内批次缺少质量记录 MUST 显式标 `quality_unavailable`。

#### Scenario: 覆盖率显著下降
- **WHEN** 某来源本窗口覆盖率较上一等长窗口下降超过阈值
- **THEN** health 报告标 regression_flagged 且命令仍正常退出

#### Scenario: 历史批次无质量记录
- **WHEN** 窗口内包含质量持久化之前写入的旧批次
- **THEN** 该来源对应段显式 quality_unavailable，不回填、不当作零覆盖

### Requirement: 市场 canary 必须消费质量记录
planned 的 `radar market canary report` 实现时 MUST 消费观测质量记录作为覆盖与解析退化证据；在其落地前该命令 MUST 继续以具名 `capability_unavailable` 拒绝，不得伪装可用。

#### Scenario: 当前调用市场 canary
- **WHEN** 在本变更范围内调用 `radar market canary report`
- **THEN** 返回具名 capability_unavailable 并说明真实观察窗口前提

