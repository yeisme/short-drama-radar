# radar-work-ingestion-gate Specification

## Purpose
以版本化规则和不可变决定约束候选作品进入 canonical 状态。
门控决定只说明当前版本证据是否满足入库条件，不认证受众需求或预测商业表现。

## Requirements
### Requirement: 入库门规则必须版本化且评估与写入分离
系统 MUST 以版本化规则集（首版 `work-ingestion-gate-rules.v1`）定义 candidate 晋级条件，至少覆盖跨批次身份印证、别名归并完成、必需字段覆盖达标与非 fixture 证据下限。`gate evaluate` MUST 为只读确定投影：同一 mapping revision、同一观测/证据现状与同一 gate_version 输出相同逐规则结果。规则或阈值调整 MUST 产生新 gate_version，旧版本下的全部决定 MUST 保持可读且不追溯重判。

#### Scenario: 规则阈值调整
- **WHEN** 字段覆盖下限从既有值上调
- **THEN** 产生新 gate_version，旧版本决定原义保留，新旧版本可并列查询

#### Scenario: 请求未知规则版本
- **WHEN** 评估或查询引用不存在的 gate_version
- **THEN** 返回具名 `gate_version_unknown` 并列出可用版本，零写入

### Requirement: 拒绝必须显式记录原因且作品保留 candidate
系统 MUST 把每次正式判定落为不可变 gate decision（`radar.work_gate_decision.v1`），verdict 为 promotable 或 rejected；rejected MUST 携带稳定英文原因码（如 `identity_not_corroborated`、`alias_conflict`、`field_coverage_below_floor`、`fixture_only_evidence`）。被拒绝的作品 MUST 保持 `mapping_status=candidate`，拒绝历史不得改写或删除。重新评估 MUST 产生新 decision_ref。

#### Scenario: 仅 fixture 证据的候选
- **WHEN** 某 candidate 的全部 supporting_evidence_refs 来自 fixture 批次
- **THEN** 判定 rejected 且原因含 `fixture_only_evidence`，映射保持 candidate

#### Scenario: 补证据后重新评估
- **WHEN** 曾被拒绝的作品获得新的非 fixture 观测证据并再次评估
- **THEN** 产生新 decision_ref，旧拒绝决定仍可查询

### Requirement: canonical 化必须留 revision 与证据引用
晋级 MUST 是显式 owner 动作：写入 `canonical_work_ref` 与 1–10 条已存 market evidence refs，产生 mapping_revision+1 的新不可变 revision；original_title、aliases 与历史 revision MUST NOT 改写，观测与证据 MUST NOT 回写。verified 映射 MUST NOT 被后续观测或评估自动降级。

#### Scenario: 通过门后晋级
- **WHEN** owner 对 operative decision 为 promotable 的 candidate 执行 promote
- **THEN** 新 revision 为 verified 且带 canonical_work_ref 与证据 refs，历史 revision 字节级不变

#### Scenario: 晋级后继续观测
- **WHEN** verified 作品所在来源再次导入同内容观测
- **THEN** 映射保持 verified，candidate 刷新零新版本

### Requirement: 入库门不得改变来源 readiness 或自动晋级
入库门 MUST NOT 修改任何来源的 readiness、资格记录或采样计划；observe、import、analyze、brief 及任何定时/后台流程 MUST NOT 依据门结果自动改写映射状态。fixture 观测 MUST NOT 计入真实验证。

#### Scenario: 观测批次使作品满足全部规则
- **WHEN** 一次 observe 后某 candidate 在评估中全部规则通过
- **THEN** 映射仍为 candidate，仅在显式 owner 动作后才可晋级

#### Scenario: 门判定与来源资格并存
- **WHEN** 某来源 readiness 为 planned 而其作品通过入库门
- **THEN** 来源 readiness 保持 planned，门结果不暗示来源已资格化

