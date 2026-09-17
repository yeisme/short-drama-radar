## Why

日韩目录已经得到真实原文样本，但个人浏览仍需逐条理解外语标题。直接改写作品标题或用译文补题材会污染身份与证据，需要独立、可追溯的中文阅读层。

## What Changes

- 新增标题译文 append-only 存储，分别支持 zh-Hans 与 zh-Hant，记录原文摘要、提交方式、修订和操作者归因。
- 新增 translation add/show 和 reading list；原文变化时译文 stale 并退回原文，缺失译文不阻塞浏览。
- 新表只在本地保存，不进入 PG 归档允许表；不改变作品标题、alias、地区、题材、排名或反馈。
- 首版接收 Agent/人工通过 CLI 提交的译文，不新增模型网络调用、自动费用或后台翻译任务。

## Capabilities

### New Capabilities

- `radar-chinese-reading`: 原文绑定的标题译文和中文阅读投影。

### Modified Capabilities

无。旧 work/brief 与输出合同继续兼容，新命令增量提供阅读视图。

## Impact

fit owner 为 Radar：阅读辅助及译文状态。DSH 可消费投影但不拥有译文真源；Auctra 的创作本地化不由本功能承担。新增一个 SQLite 表与 CLI 分支，无外部依赖或公共 API 扩展。已存原文和冻结简报不迁移、不重写。
