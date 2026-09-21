## ADDED Requirements

### Requirement: Real owner acceptance and durable review

验收入口 MUST 只采集真实 owner 投影，在来源不足或读取失败时报告缺口；评价反馈由 owner 服务持久化，不得改 canonical 业务状态。

#### Scenario: Missing source

- **WHEN** 无法取得授权案例
- **THEN** 返回 typed gap，零 provider call，不生成替代样本。

#### Scenario: Review replay

- **WHEN** 同一 source_digest 和 request_id 重放反馈
- **THEN** 返回同一回执；冲突拒绝，反馈不执行业务采纳。
