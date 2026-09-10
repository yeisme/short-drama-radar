## Context

在现有 owner application service 上增量实现输入控制与字节传输。

## Decisions

先发现权限与传输 readiness，再按文件元数据选择自动上传或 awaiting_file。单次页面兑换及短时 grant 不接受长期 bearer。状态和文件由本项目持有；不引入中央上传服务。持久化、并发、媒体限制、幂等、恢复和导入服从本项目现有规则。

## Verification

复用项目测试 runner；验证自动/手动、重启、续期、取消、重复完成、身份和项目隔离、容量/类型校验。集成结果写入本项目 temp/integration-test-runs。

## Rollback

默认关闭。禁用入口保留已完成文件和旧接口，不自动部署或变更凭据。

## 最终接线

紧凑 `radar.execute` 新增 `input.prepare/status/renew/abort/import`，参数位于 `input`，schema 在 `radar://input/capabilities`。只有显式 input listener 的 operator 连接可调用；只读与 curator 不扩权。首批只接入现有 UTF-8 CSV 合同（platform/title/url 必填），上限 2 MiB；截图或其他格式仍不冒充已实现。完成后 `input.import` 调用原人工导入 application service，证据保持 Layer 3、低置信度语义，不调用采集或改 Profile。导入结果未知时返回 unconfirmed，不重复导入。

运行与兼容说明见 [输入指南](../../../docs/mcp-input-intake.md)。输入表增量创建，不修改旧资产表；关闭入口回滚保留已完成引用，未完成请求经原 owner 取消。公共 stateless helper 注入本 owner repository/backend；Radar 使用本项目 Bun/Drizzle 实现同合同。传输凭据不进入普通 JSON 回执。
