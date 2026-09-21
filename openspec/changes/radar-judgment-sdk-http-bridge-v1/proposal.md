# Proposal

## Why

现有领域 seam 与公共 SDK 不同且 CLI 只有 fixture，无法进行真实合同联调。

## What Changes

保留历史 seam/fixture，新增 bridge 将领域数据映射至公共 SDK；SDK 本地打包随项目固定依赖；新增显式 HTTP endpoint/model/临时认证 env 名参数，cache 绑定 transport/model/mode；回放不访问网络。

## Capabilities

### New Capabilities

- `reading-judgment-sdk-http-bridge`：本轮修复与兼容消费。

### Modified Capabilities

无；既有合同不删除、不改名。

## Impact

仅 owner 本地实现、脱敏测试与文档；无部署、真实凭据或付费调用。
