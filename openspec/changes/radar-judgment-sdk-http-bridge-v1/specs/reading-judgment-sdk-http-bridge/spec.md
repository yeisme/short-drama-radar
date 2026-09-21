## ADDED Requirements

### Requirement: Compatible verified transport

实现 MUST 满足：保留历史 seam/fixture，新增 bridge 将领域数据映射至公共 SDK；SDK 本地打包随项目固定依赖；新增显式 HTTP endpoint/model/临时认证 env 名参数，cache 绑定 transport/model/mode；回放不访问网络。

#### Scenario: Safe explicit execution

- **WHEN** 用户显式评估或上游返回错误
- **THEN** 按已校验的合同处理，不自动重试、不泄露自由文本，不影响旧 fixture 和历史读取。

#### Scenario: Offline verification

- **WHEN** 使用假上游联调
- **THEN** 实际 SDK 与 adapter 合同参与测试，成功与失败均保存脱敏证据。
