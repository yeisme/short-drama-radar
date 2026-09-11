# mcp-input-intake Specification

## Purpose
TBD - created by archiving change radar-mcp-input-intake-v1. Update Purpose after archive.
## Requirements
### Requirement: 自描述的受限输入请求
Radar SHALL 通过真实 MCP 注册表和 `radar://input/capabilities` 提供请求 schema、HTTP 合同、身份限制和显式可用状态。新增入口默认关闭，旧凭据不自动扩权。

#### Scenario: 无产品 CLI 且尚未选文件
- **WHEN** 已授权客户端用原任务用途和幂等键创建请求而没有 file
- **THEN** 返回 awaiting_file、稳定 request ID 和独立的临时传输/页面链接
- **AND** 不读客户端路径或请求 MCP base64 字节

### Requirement: 校验、恢复与原生领域回执
Radar SHALL 复用本项目持久化和领域服务，一个请求仅绑定一个文件；上传、领域消费和 canonical 采纳分别表示。

#### Scenario: 中断后重放完成
- **WHEN** 客户端通过原请求查询并重复 complete
- **THEN** 返回同一稳定引用，不重复创建文件资产或生成任务
- **AND** 缺少领域权限时保留已传输状态并停在原业务门

### Requirement: 一次性页面和传输边界
Radar SHALL 只持久化 grant 摘要，绑定身份、项目、请求、HTTP 方法与字节限额；页面凭据仅在 fragment 中单次兑换，并校验同源请求。

#### Scenario: 非法输入与错误身份
- **WHEN** 请求带错误身份、项目、过期凭据、路径穿越、错误 MIME 或超限内容
- **THEN** 请求被拒绝，回执与审计不得暴露长期密钥或临时链接

### Requirement: Owner 分域消费
Radar SHALL 遵循下列领域边界：紧凑 `radar.execute` 新增 `input.prepare/status/renew/abort/import`，参数位于 `input`，schema 在 `radar://input/capabilities`。只有显式 input listener 的 operator 连接可调用；只读与 curator 不扩权。首批只接入现有 UTF-8 CSV 合同（platform/title/url 必填），上限 2 MiB；截图或其他格式仍不冒充已实现。完成后 `input.import` 调用原人工导入 application service，证据保持 Layer 3、低置信度语义，不调用采集或改 Profile。导入结果未知时返回 unconfirmed，不重复导入。

#### Scenario: 上传成功但业务尚未批准
- **WHEN** 字节校验成功而下游审核、导入确认或分析许可尚未满足
- **THEN** 回执分别说明输入引用与 domain_state，不执行未授权业务

