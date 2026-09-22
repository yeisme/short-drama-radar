# 阅读判断（reading-judgment）校准与渐进接入说明

对应 OpenSpec change：`radar-reading-judgment-v1`（能力 `reading-judgment`）。

## 定位

辅助 Morning Edition 与中文阅读列表的相关性、重复性和待核实项判断。模型只出建议；确定性规则与人工审阅保持权威。判断置信度永不写入 `evidence_confidence`，语言永不等同受众地区，建议永不改写 canonical 排序。默认**完全休眠**：实验性开关 `judgment.enabled` 默认 `false`，`evaluate`/`accept` 直接拒绝（`capability_disabled`），零 transport 装配、零模型调用、零写入。

当前状态：**exploratory（探索期）**。离线合同测试通过不代表真实模型效果；没有任何自动 live 路径。

## 实验性开关（radar-reading-judgment-v1 task 2.1）

用户级配置文件（默认 `~/.short-drama-radar/config.json`，可用 `RADAR_CONFIG_PATH` 重定向）新增 `judgment` 节：

```json
{
  "judgment": {
    "enabled": true,
    "mode": "shadow"
  }
}
```

- `enabled`（默认 `false`）：实验性能力总门。`false` 时 `judgment evaluate`/`accept` 返回 `capability_disabled`，不解析 flag、不装配 transport、不写库；`status`/`show`/`evidence` 仍可用（零调用零写入的只读面）。
- `mode`（默认 `off`，可选 `off|shadow|assist`）：启用后的 `evaluate` 默认模式来源；命令行 `--mode` 显式传参时覆盖配置。`enabled=true` + `mode=off` 表示每次评估仍需显式 `--mode`。
- 非法配置（`enabled` 非 boolean、`mode` 不在枚举内、`judgment` 非对象）在加载时 fail-fast（`config_invalid`）。
- `enabled=false` 时即使残留 `mode=shadow|assist` 也保持休眠：关闭永远是单次配置翻转，立即恢复旧流程。
- 没有任何 env、定时器、升级路径或默认值会启用该能力；只有用户显式改配置文件。

## 使用面（本地 CLI，无 MCP/server）

```bash
radar judgment status                       # 配置门/模式/传输/已存 attempt；零模型调用
radar judgment evaluate --target edition --mode assist --transport fixture
radar judgment evaluate --target reading --language zh-Hans --transport fixture   # 模式取自配置
radar judgment show --attempt <key>         # 零网络重放
radar judgment evidence --attempt <key>     # 脱敏证据视图（refs/digests/review 状态）
radar judgment accept --attempt <key> --candidate <id> --kind <feedback kind>
```

- 未启用（默认）：`evaluate`/`accept` 拒绝并提示如何启用；零发现、零远程调用、零写入。
- `off`：启用但默认模式为 off 时，`evaluate` 仍需显式 `--mode shadow|assist`。
- `shadow`：只比较建议与基线，不能采纳。
- `assist`：展示建议、缺失项与原审阅入口；采纳仍走原 feedback/阅读面流程并重新校验新鲜度与权限。

默认传输是离线 `judgment-fixture`；新增 `--transport http` 经本地打包的公共 SDK 接入已授权适配器，必须显式配置，不自动启用。旧领域 seam 与公共 SDK wire 由 bridge 明确转换，不能直接互换。

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

- 关闭：默认即关闭（`judgment.enabled=false`）；把配置改回 `false` 即单次翻转关闭，`evaluate`/`accept` 立即回到 `capability_disabled`。没有定时器或升级路径会启用判断。
- 恢复：原命令、默认配置与 canonical state 从未改变；历史判断证据保持只读可查（`status`/`show`/`evidence` 关闭态仍可用）。
- 数据：关闭/恢复不删除任何用户数据、反馈、翻译或凭据。

## live canary 前置（未排期，不自动）

真实评估需要：owner 显式 opt-in、公共 SDK 真实 transport、exact model pin、可见预算；且以本文件记录的校准/留出结果为准。升级、schedule、read/status 命令永远不会触发。


## 公共 SDK HTTP 路径（2026-09-21）

本次已完成真实公共 SDK 与 Go OpenRouter adapter 的离线系统联调；上游为网络隔离的假实现，未运行真实付费评估，效果仍为 exploratory。

CLI 默认仍是 fixture。使用 HTTP 时必须显式提供 endpoint、model、adapter access token 的环境变量名；该 token 是适配器访问凭据，不是 OpenRouter/TypeSafe key。用户已有环境配置完成后可运行（此命令可能触发付费模型）：

```bash
radar judgment evaluate --mode shadow --transport http --endpoint http://127.0.0.1:40871 --model typesafe/jev-1.13 --auth-env RADAR_JUDGMENT_ADAPTER_TOKEN
```

只允许 HTTPS 或 loopback HTTP，禁止 URL userinfo/query/fragment。read/status/show 不发模型请求；历史 v1 记录不重写。cache 绑定 endpoint/model/bridge 及 mode，fixture 不会冒充 HTTP 结果。领域 input_digest 保持旧语义，新增 sdk_input_digest 保存公共 SDK 的实际请求摘要，两者不冒充等价。

公共 SDK 使用本仓 `vendor/yeisme-judgment-sdk-0.1.0-review2.tgz`，由 Bun 打包并在 lockfile 固定完整性，不需要相邻 Aigora 仓库才能安装/运行。它是本地构建快照，没有公开发布；后续更新必须重新打包为新文件名并由包管理器更新依赖。

### 离线系统验证

先在 Aigora 的 adapter 模块构建仅用于测试的服务，再在 Radar 运行：

```bash
cd /workspaces/yeisme-agent/apigateway/aigora/adapters/openrouter-decisions
CGO_ENABLED=0 go build -o /tmp/judgment-radar-conformance ./internal/radarconformance
cd /workspaces/yeisme-agent/cli/short-drama-radar
RADAR_JUDGMENT_ADAPTER_TEST_BIN=/tmp/judgment-radar-conformance bun run scripts/integration-test-run.ts -- bun test test/integration/reading-judgment-sdk-http.test.ts
```

测试服务只使用内存假凭据、不可联网的 upstream client 和回环监听。普通独立仓测试没有该可选 binary 时明确 skip 跨项目场景，不以 skip 当作系统验收通过；本次已显式运行该场景。


## 用户授权的付费 canary（2026-09-21）

本次通过 Radar 应用服务 → 公共 TS SDK → Go OpenRouter adapter → OpenRouter Decisions 真实闭环，使用临时内存数据库中的合成候选、shadow 模式，不触及用户作品或已有 Radar 数据。

- 单次上游请求，返回 3 个原子判断，execution_status=succeeded；模型报告 `typesafe/jev-1.13-20260917`（不等于验证底层权重版本）。
- 已返回用量：875 input tokens、86 output tokens；API usage.cost=0.00003675 USD。provider 调用耗时 609 ms，评估及回放检查约 627 ms；不是长期延迟基准。
- 回答分别为 relevant（供应商 confidence=0.98）、非重复（重复概率 0.14）、需核实（概率 0.94）。合成输入只证明连通/合同，不代表领域判断效果已校准。
- 上游计数=1；再次评估使用已保存结果，零网络回放；Edition digest 未变，没有采纳反馈、重排或自动执行。
- 用户授权仅用于这次临时进程：通过 credentialctl exec 注入既有 OpenRouter secret，使用显式的一次性 in-process authorization；没有增加持久 grant，不宣称生产 credentialctl readiness/部署链路已验证。
- 清理时凭据启动器退出留下临时 adapter 子进程，已确认 executable 后终止；未追加付费请求。临时运行脚本改为独立进程组清理，改动后未重复 live 调用。

证据：[本轮集成 summary](../../temp/integration-test-runs/2026-09-21T14-44-41-843Z-aqapvf/summary.json)、[脱敏结果](../../temp/integration-test-runs/2026-09-21T14-44-41-843Z-aqapvf/stdout.log)。临时证据不随发布入库。
