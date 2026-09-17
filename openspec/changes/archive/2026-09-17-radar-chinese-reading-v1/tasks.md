## 1. 中文标题阅读层

由 scripts/chinese-reading-check.ts 生成；单 writer，领域状态由 CLI／服务维护。

- [x] 1.1 译文与原文绑定存储；owner=radar；scope=translation 服务及本地表；验收=幂等、修订、失效、简繁隔离、原文不变；验证=market-translation 集成测试。
- [x] 1.2 中文阅读 CLI；owner=radar；依赖=1.1；验收=原文回退、政策、输出模式、无模型网络调用；验证=market-translation 进程测试。
- [x] 1.3 使用文档与后续边界；owner=radar；依赖=1.2；验收=真实命令、未审核声明、不覆盖地区/题材/身份；验证=文档与 CLI 合同对照。
- [x] 1.4 软件收口；owner=radar；依赖=1.1–1.3；验收=类型、全量测试含真实 PG、strict OpenSpec；验证=bun run scripts/chinese-reading-check.ts --verify。

## 2. 验证

类型、完整测试与 strict spec 通过。软件证据：temp/integration-test-runs/2026-09-17T02-49-56-066Z-d6aa7f。真实样本译文演练单独记录于运行文档，不代表人工审核或市场验证。
