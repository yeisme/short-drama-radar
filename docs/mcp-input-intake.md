# Radar MCP 文件输入

本地候选实现，默认关闭。能力资源：`radar://input/capabilities`；入口：`radar.execute`；用途：`manual_evidence`；项目绑定：显式 --input-project。完成回执：radar://input/<id>；显式 input.import 后返回原人工导入 run 引用。

紧凑 `radar.execute` 新增 `input.prepare/status/renew/abort/import`，参数位于 `input`，schema 在 `radar://input/capabilities`。只有显式 input listener 的 operator 连接可调用；只读与 curator 不扩权。首批只接入现有 UTF-8 CSV 合同（platform/title/url 必填），上限 2 MiB；截图或其他格式仍不冒充已实现。完成后 `input.import` 调用原人工导入 application service，证据保持 Layer 3、低置信度语义，不调用采集或改 Profile。导入结果未知时返回 unconfirmed，不重复导入。

## 客户端不需要产品 CLI

先读本 owner 的 `://input/capabilities` 资源，并通过 `tools/list` / `inputSchema` 获取真实工具名。紧凑 execute 的子动作 schema 在能力资源中；Gateway 的工具名由 Gateway 发现结果映射，不能自行拼接命名空间。未启用时按实际 readonly/unavailable 处理，不尝试猜测 HTTP URL。

1. 使用原任务的用途与幂等键创建输入请求。文件元数据未知时省略 `file`，状态为 `awaiting_file`；已知时提交 `name`、`mime`、`size`，`sha256` 可省略。
2. 原请求返回安全状态和单独的临时 `resource_link` 内容。链接不进入普通回执、日志、录像、审计正文、笔记或任务存储。
3. 宿主能读取文件并发送 HTTP 时：只在内存中提取 `#grant=`，移除 fragment 后使用返回 URL；请求头为 `X-Input-Grant`。POST `/file` 绑定元数据，PUT `/content` 流式传输并设置精确 Content-Length，POST `/complete` 校验。禁止重定向，禁止附带长期 MCP/service bearer。
4. 纯 MCP 宿主使用 `#page=` 链接，让用户在同源页面选一个文件。页面兑换后清除 fragment，使用 HttpOnly/SameSite 浏览器会话；没有第三方脚本。选文件不批准生成、覆盖或分析。
5. Agent 查询原输入请求的 `status`，用稳定引用补齐原任务。只有原业务授权仍有效才继续；审核、付费、覆盖确认仍由 owner 决定。

一个请求只绑定一个文件；多参考图用多个输入槽。网络错误或结果不明时先查询原请求；如果连 ID 都未收到，以同一幂等键重放 prepare 取得已有请求，再显式 renew，不能换键重建。grant 默认五分钟、页面兑换十五分钟；均受原会话到期时间限制。已到期的整个输入请求不能以 renew 延长成新会话；status 保留过期事实，owner 可取消并按原任务重新授权。

`state=transferred` 表示字节已收到，`verifying` 表示校验中，`ready` 表示已有稳定输入回执。`failed` 的 `resume_state`、`failure_code` 保留传输和校验区别。`receipt.domain_state` 与上传状态分别消费，不能把 ready 当成 canonical 已采纳。重复 complete 返回同一回执。并发操作冲突须先查询；服务重启可能需要等待原有操作 lease 到期。

## Owner 侧启用

以下命令在服务所在机器执行，前提是原服务身份、项目、存储和 HTTP listener 已配置。示例只展示新增入口，不构成部署或权限变更指令。新增入口默认关闭；关闭后保留已完成资产和回执。没有可达 listener 的 stdio 客户端不能把本地路径交给远端消费。

```bash
radar mcp --lane operator --input-listen 127.0.0.1:8740 --input-base-url http://127.0.0.1:8740 --input-project creative
```

现有 CLI、旧上传会话、工具与原凭据权限继续保留。页面仅限本次输入：选择、进度、重试、取消与状态，不扩展为首页、资产库或后台。

## 验证与候选状态

实现 change：`openspec/changes/radar-mcp-input-intake-v1/`。本地 fixture 证据保存在 `temp/integration-test-runs/`；发布、远端部署与真实 Provider 验证单独执行。不能用已连接旧二进制的发现结果推断本地候选代码已部署。

存储拒绝与传输错误分别恢复：`storage_capacity_unavailable` 表示容量不足，`storage_unavailable` 表示存储不可写或不可用；HTTP 对应 507/503。恢复容量后沿用原请求，不换幂等键制造重复输入。领域权限缺失仍由 domain_state 表示。
