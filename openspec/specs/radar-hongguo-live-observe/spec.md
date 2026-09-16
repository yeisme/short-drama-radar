# radar-hongguo-live-observe Specification

## Purpose
TBD - created by archiving change radar-hongguo-live-assignment-v1. Update Purpose after archive.
## Requirements
### Requirement: 红果验证采样必须能写入 live 观测
系统 SHALL 提供 `radar market observe --source hongguo --mode verify-sample --confirm-live`。当来源不是 `blocked` 时 MUST 抓取固定公共目录页，解析后以 `origin=live` 入库，MUST NOT 自动把 readiness 标为 qualified。`--fixture` MUST 走同一命令且 origin 保持 fixture。`import-catalog` MUST NOT 铸造 live。

#### Scenario: 未合格来源做验证采样
- **WHEN** hongguo readiness 为 planned 或 identity_verified，且 owner 提供 `--confirm-live`
- **THEN** 成功批次 origin=live，source readiness 不变，简报若使用这些信号仍为 degraded

#### Scenario: 缺少 owner 授权
- **WHEN** 未提供 `--confirm-live` 且未提供 `--fixture`
- **THEN** 返回 `owner_authorization_required`，零写入

#### Scenario: 导入不能冒充 live
- **WHEN** 调用 `import-catalog`
- **THEN** origin 只能是 fixture 或 manual

### Requirement: 生产观察必须有资格门
`--mode production` MUST 仅在 hongguo 为 `sample_verified` 或 `qualified` 时采集。其他来源 MUST 返回具名 `source_unsupported` 或既有拒绝。blocked 来源 MUST 拒绝。

#### Scenario: 未合格生产观察
- **WHEN** planned 来源使用 `--mode production --confirm-live`
- **THEN** 拒绝且零写入

### Requirement: 失败必须可区分
空目录、登录墙、Firecrawl 失败、超时 MUST 映射为 `source_unavailable` 或 `observation_invalid`，MUST NOT 把缺数据写成无变化。证据 MUST NOT 含原始 HTML、cookie 或本地路径。

#### Scenario: 登录页
- **WHEN** 页面无可解析作品链接
- **THEN** `source_unavailable`，batches/observations/evidence 零新增

### Requirement: live observe 的解析质量必须同事务持久化
`radar market observe`（verify-sample 与 production 两种模式）MUST 在写入 live/fixture 观测批次的同一事务写入 `radar.observation_quality.v1` 质量记录，携带该批次的 field_coverage 与 skipped 归因；批次重放 MUST 复用原质量记录。该持久化 MUST NOT 改变 observe 的来源范围、资格门、owner 授权要求与失败语义。

#### Scenario: 验证采样落质量记录
- **WHEN** `--mode verify-sample --confirm-live` 成功写入 live 批次
- **THEN** 同事务存在该批次一对一质量记录，source readiness 不变

#### Scenario: fixture 模式同样留记录
- **WHEN** `--fixture` 成功写入 fixture 批次
- **THEN** 质量记录 origin=fixture，且不计入任何真实验证或资格判断

