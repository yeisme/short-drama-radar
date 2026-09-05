# Design

## 解析顺序

launchPlaywright 先做纯文件系统检查（凭据 storageState、代理解析），再 dynamic import playwright、再 launch——配置错误的账号在浪费浏览器启动前就显式降级，且该路径无需 chromium 即可测试（两个 gate 测试覆盖缺凭据/缺代理）。

## 秘密边界

secret 文件内容只进 `newContext({ storageState })` 与 chromium launch options；SecretsError/降级消息仅包含 ref、路径与修复命令。文件模式 >0600 拒绝（chmod 600 提示）。坏 JSON/坏形状（无 cookies 数组、server 非 http(s)）显式报错。

## capabilities 派生 vs fixture 快照

capabilities(deps, layer2?) 保持纯函数（无 layer2 参数时返回静态 blocked 兜底，供测试）；CLI 与 MCP 资源路径传入 probeLayer2 结果。fixture 测试对非派生条目做精确匹配，layer2 由 CLI 合同测试断言 "blocked 必带 reasons / ready 无 reasons"。

## 配额

AdapterContext.dailyQuotaPerAccount ← config.accountPool.dailyQuotaPerAccount（默认 200 不变）；deps.dailyQuota（测试注入）优先。
