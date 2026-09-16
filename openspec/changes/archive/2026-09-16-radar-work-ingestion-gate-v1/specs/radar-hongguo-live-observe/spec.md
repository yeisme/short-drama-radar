## ADDED Requirements

### Requirement: live observe 的解析质量必须同事务持久化
`radar market observe`（verify-sample 与 production 两种模式）MUST 在写入 live/fixture 观测批次的同一事务写入 `radar.observation_quality.v1` 质量记录，携带该批次的 field_coverage 与 skipped 归因；批次重放 MUST 复用原质量记录。该持久化 MUST NOT 改变 observe 的来源范围、资格门、owner 授权要求与失败语义。

#### Scenario: 验证采样落质量记录
- **WHEN** `--mode verify-sample --confirm-live` 成功写入 live 批次
- **THEN** 同事务存在该批次一对一质量记录，source readiness 不变

#### Scenario: fixture 模式同样留记录
- **WHEN** `--fixture` 成功写入 fixture 批次
- **THEN** 质量记录 origin=fixture，且不计入任何真实验证或资格判断
