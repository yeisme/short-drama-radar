# 阅读判断（reading-judgment）校准与渐进接入说明

对应 OpenSpec change：`radar-reading-judgment-v1`（能力 `reading-judgment`）。

## 定位

辅助 Morning Edition 与中文阅读列表的相关性、重复性和待核实项判断。模型只出建议；确定性规则与人工审阅保持权威。判断置信度永不写入 `evidence_confidence`，语言永不等同受众地区，建议永不改写 canonical 排序。默认 `off`：不显式传 `--mode shadow|assist` 就没有任何模型调用。

当前状态：**exploratory（探索期）**。离线合同测试通过不代表真实模型效果；没有任何自动 live 路径。

## 使用面（本地 CLI，无 MCP/server）

```bash
radar judgment status                       # 模式/传输/已存 attempt；零模型调用
radar judgment evaluate --target edition --mode assist --transport fixture
radar judgment evaluate --target reading --language zh-Hans --mode shadow --transport fixture
radar judgment show --attempt <key>         # 零网络重放
radar judgment evidence --attempt <key>     # 脱敏证据视图（refs/digests/review 状态）
radar judgment accept --attempt <key> --candidate <id> --kind <feedback kind>
```

- `off`（默认）：零发现、零远程调用、零写入。
- `shadow`：只比较建议与基线，不能采纳。
- `assist`：展示建议、缺失项与原审阅入口；采纳仍走原 feedback/阅读面流程并重新校验新鲜度与权限。

唯一已接线的传输是离线 `judgment-fixture`（合同形状冻结：schema_version "1.0"、snake_case、DescribeCapabilities/Evaluate、错误码集、choice/ordinal_score/binary）。公共 SDK 包发布后经同一注入 transport seam 接入，不自动启用。

## Baseline

| 面 | 基线 |
| --- | --- |
| Morning Edition | 既有确定性排序（`radar edition build/show`） |
| 中文阅读列表 | 既有列表顺序（`radar market reading list`） |

建议只与基线对比展示（attempt 记录中的 `baseline`），绝不覆盖。

## 留出集与语言

- 语言：`zh-Hans`、`zh-Hant`、`en` 分别校准，条目不跨语言共享。
- 每语言 20–30 条已标注集只是探索起点，不能标注 mature；校准集与留出集分离。
- 阈值按任务与语言分别固定（见 `radar.reading_judgment.policy.v1`），当前全部 `null`（未校准），没有全局 0.8 之类默认值。

## 度量（中文/英文分别报告）

- 对照基线的有用条目留存率（`useful_retention_vs_baseline`）
- 对照基线的漏看项（`missed_items_vs_baseline`）
- 误报率（`false_positive_rate`）/ 漏报率（`false_negative_rate`）
- 拒答率（`abstention_rate`）、延迟（`latency_ms`）、已知用量（`known_usage`，unknown 不当 0）

成功标准是"对照原排序的有用条目留存与漏看项"，不是模型自报高分或 confidence。

## 失败与边界行为

- 模型拒答/低信心 = `abstained`；401/503/格式错误 = 执行错误；提交后超时 = `outcome_unknown`（不自动重发、不换付费模型；重放零网络，明确 `--fresh` 才开新 attempt）。
- 必需问题（`morning_relevance`、`needs_verification`）任何缺项/拒答阻止完整建议采纳。
- 采纳前重验：源版本/权限变化 → `judgment_stale`；内容被策略屏蔽 → `permission_revoked`（不确认被屏蔽内容的存在性）。
- 注入边界：候选文本是不可信输入；凭据形态文本在投影层即被排除（`sensitive_material`），指令形态文本只是有界输入，不产生任何动作。

## 关闭与恢复

- 关闭：不传 `--mode` 即关闭；没有配置项、定时器或升级路径会启用判断。
- 恢复：原命令、默认配置与 canonical state 从未改变；历史判断证据保持只读可查。
- 数据：关闭/恢复不删除任何用户数据、反馈、翻译或凭据。

## live canary 前置（未排期，不自动）

真实评估需要：owner 显式 opt-in、公共 SDK 真实 transport、exact model pin、可见预算；且以本文件记录的校准/留出结果为准。升级、schedule、read/status 命令永远不会触发。
