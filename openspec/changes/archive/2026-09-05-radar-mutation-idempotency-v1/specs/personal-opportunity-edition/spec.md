## MODIFIED Requirements

### Requirement: Morning Edition 必须不可变并允许空榜
系统 SHALL 生成 `radar.morning_edition.v1`，固定绑定 date、profile ref/revision、builder/ranker version、run/source refs、entries、status、known limitations 与 next actions。Edition 创建后 MUST 不被 Profile 更新、反馈或重跑覆盖。Edition 身份 SHALL 由输入指纹（ranked 输入元组与 limit，反馈调整体现在其中）加 profile ref/revision 确定性导出；相同输入的重建 MUST 返回同一不可变 Edition 并标记复用，MUST NOT 追加重复行。

#### Scenario: 生成高精度个人版次
- **WHEN** 有不超过 limit 且满足 minimum fit/confidence 的机会
- **THEN** 系统按稳定顺序创建 `ready` Edition，并为每项保存当时的个人投影快照

#### Scenario: 没有合格机会
- **WHEN** 所有机会被阈值、blocked topics 或重复抑制排除
- **THEN** 系统创建 `empty` Edition，entries 为空，并给出可区分的原因与 next action

#### Scenario: 相同输入重建
- **WHEN** 同一 profile revision、同一数据与同一 limit 再次执行 edition build（CLI 或 MCP）
- **THEN** 系统返回同一 editionRef 的既有 Edition 并标记 `idempotent_reuse`，不产生新行

#### Scenario: 后续反馈不改历史
- **WHEN** 用户在 Edition 生成后对其中机会提交 `dismissed`
- **THEN** 原 Edition 内容和 digest 不变，反馈只影响后续新 Edition
