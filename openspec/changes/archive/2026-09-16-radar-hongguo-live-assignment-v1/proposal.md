## Why

市场软件门已过，但 live 观察仍 `capability_unavailable`，也没有把 Edition 变成生产任务的合同。本切片接通红果公共目录验证采样，并增加 typed assignment。

## What Changes

- `radar market observe --source hongguo --mode verify-sample|production`：Firecrawl 抓固定目录页，解析后以 `origin=live` 入库；`--fixture` 仅测路径。
- `import-catalog` 仍只能 `fixture|manual`。
- `radar assignment create|show|reject`：从 Edition（可选 Brief）生成不可变任务；空榜为 `do_not_shoot`；拒绝写 `too_risky|not_relevant` 反馈。
- 不调用 Auctra、不写 `used`、不开放 MCP 写入、不自动晋级 qualified。

## Capabilities

### New Capabilities

- `radar-hongguo-live-observe`
- `radar-production-assignment`

### Modified Capabilities

- `radar-market-observations`：observe 从拒绝改为有界红果入口；其他来源仍拒绝。

## Impact

`src/market/`、`src/pipeline/assignment.ts`、`src/db/`、CLI、测试与产品文档。兼容 `card.v1` 与既有市场读取。
