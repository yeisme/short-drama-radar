## ADDED Requirements

### Requirement: Explicit advisory evaluation

Radar MUST 默认关闭判断调用；仅对明确选择且授权的数据执行评估，结果只是建议。不得生成市场数据、把语言等同受众地区、自动修改 Profile、隐藏反例或把 judgment confidence 写入 evidence_confidence。

#### Scenario: Off mode

- **WHEN** 用户未启用判断功能
- **THEN** 原流程、默认配置和 canonical state 保持不变，零模型调用。

#### Scenario: Suggestion only

- **WHEN** 模型给出高置信度回答
- **THEN** 只生成待审建议，不绕过原采纳和授权门。

### Requirement: Versioned evidence and safe failure

Radar MUST 绑定 owner scope、source revision、question/policy digest 与精确模型，区别拒答、不可用和过期。

#### Scenario: Stale source

- **WHEN** 源版本或权限在评估后变化
- **THEN** 历史建议只读，不可用于新版本采纳；重新评估必须显式发起。

#### Scenario: Uncertain execution

- **WHEN** 提交后超时或结果状态不明
- **THEN** 报告 outcome_unknown，不自动重试或切换付费模型；保留原流程。

#### Scenario: Replay

- **WHEN** 用户查看已保存的判断 evidence
- **THEN** 零网络重放已归一化结果，不重新调用 provider。

### Requirement: Domain ownership and bounded input

Radar MUST 在调用与缓存读取前执行领域权限和确定性检查，仅发送有界的必要文本。输入范围：通过来源准入的 observation 摘要、work refs、语言/市场标签、Profile 的已授权偏好与当前 reading candidates。

#### Scenario: Permission denied

- **WHEN** 候选或旧缓存不再授权给当前主体
- **THEN** 不发送、不展示，也不泄露未授权内容存在性。

#### Scenario: Unsupported modality

- **WHEN** 请求结论需要 adapter 未支持的模态或原语
- **THEN** 预检拒绝并指向原领域工作流，不能把文本结果升级为媒体结论。

### Requirement: Domain-specific review boundary

Radar MUST 保持以下领域限制：不得生成市场数据、把语言等同受众地区、自动修改 Profile、隐藏反例或把 judgment confidence 写入 evidence_confidence。

#### Scenario: morning-relevance

- **WHEN** 按已选关注点辅助排序
- **THEN** 来源准入/覆盖检查；交回原 reading list，不越权修改 canonical state。

#### Scenario: cross-market

- **WHEN** 区分内容语言与目标市场
- **THEN** 缺资料保留 unknown；交回原 market brief，不越权修改 canonical state。

#### Scenario: false-negative-retention

- **WHEN** 保留原列表并允许显式反馈
- **THEN** 不得自动丢弃；交回既有 feedback 流程，不越权修改 canonical state。
