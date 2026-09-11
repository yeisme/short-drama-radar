## ADDED Requirements

### Requirement: 来源目录必须记录真实资格与覆盖范围
系统 MUST 通过 CLI/application service 创建和维护来源目录，区分 planned/identity_verified/sample_verified/qualified/blocked 与运行 health，保存身份依据、地区、语言、采样范围、指标定义、freshness 和限制。红果短剧/红果漫剧及产品文档中的地区候选 MUST 有资格任务，失败不能静默删除。

#### Scenario: 只有官方商店条目
- **WHEN** Kuku TV 或红果漫剧仅核实产品及开发者身份
- **THEN** 仅可标 identity_verified，不声称作品级覆盖、当地热度或自动采集已可用

#### Scenario: 单次页面提取成功
- **WHEN** 红果或 ReelShort 返回一份可解析作品目录
- **THEN** 记录样本、稳定 ID 与口径检查，不能直接标 qualified

#### Scenario: 持续观测达到资格
- **WHEN** 日更目录源连续 7 天每天至少两个计划内成功观测，采样口径一致且无未解释身份漂移
- **THEN** 可对声明的 sampling_scope 标 qualified，不能扩称全平台覆盖

### Requirement: 地区与语言以及内容形式必须分离
Observation MUST 分别保存地区依据、locale、format 和 production_method，缺少依据使用 unknown/global，不从语言、平台名称或商店地区推断真实受众或 AI 制作。

#### Scenario: 英语全球首页
- **WHEN** 来源只有英语首页且没有地区级榜单或受众信息
- **THEN** 市场范围保持 global/unknown，不能归入美国受众趋势

#### Scenario: 漫剧未标制作方式
- **WHEN** 作品来自漫剧平台但没有 AI 制作证据
- **THEN** format 可为 animation，production_method 为 unknown，不能计作 AI 作品

### Requirement: 观测必须幂等且原子入库
系统 MUST 以 source/revision、来源 item identity、有效观测时间与 batch 指纹保存不可变观测和 provenance；重复 batch 不增加样本，非法 batch 不部分提交。业务访问 SHALL 使用 Drizzle。

#### Scenario: 断线后提交同一批数据
- **WHEN** 同一 batch 被再次提交
- **THEN** 返回原回执和观测 refs，样本计数不变

#### Scenario: 空输入和缺失输入
- **WHEN** 请求缺少必需身份或 batch 字段，或者合法来源返回空集合
- **THEN** 缺字段返回 observation_invalid；合法空集合记录 empty observation 和采样状态，不把两者混成采集成功有数据

### Requirement: 来源失败必须隔离且不得绕过风控
单源超时 SHALL 最多重试两次，登录或验证码失败 MUST 停止自动重试并记录 owner 恢复方式；其他来源继续，截止时可生成 partial 简报。

#### Scenario: 多源中一个超时
- **WHEN** 两个来源成功而一个持续超时
- **THEN** 成功观测保留，失败来源进入 coverage 缺口，不使整个日报消失

#### Scenario: 触发风控
- **WHEN** 来源显示验证码或明确风控
- **THEN** 使用 source_risk_control 与 24 小时冷却，不破解或改换身份自动绕过

### Requirement: 作品与证据独立性必须显式建模
作品映射 MUST 区分 candidate/verified 并保存依据与版本；相似标题不自动合并。独立印证 SHALL 按原始证据和 publisher_group 去重。

#### Scenario: 同名不同作品
- **WHEN** 两个平台的作品名称相同但没有身份关联证据
- **THEN** 保留独立 platform_work_ref，仅产生候选对应

#### Scenario: 多账号转载
- **WHEN** 多个账号转载同一榜单截图或同一原始内容
- **THEN** 不增加独立印证数，并保留来源血缘

### Requirement: 人工与外部输入必须经过 owner 合同
导入 MUST 使用 Radar CLI/application service 或已实现的 input-intake；fixture/manual/live 必须分开，不能手写运行资产或把客户端路径当作远端数据。

#### Scenario: 无 CLI 的客户端上传
- **WHEN** 已连接 Agent 只有本机 CSV 而 Radar 数据在另一 host
- **THEN** 仅在发现已实现 input-intake 合同后使用它，否则返回 input_unavailable，不把路径/base64 伪装成 evidence ref
