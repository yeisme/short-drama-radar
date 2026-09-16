## Why

2026-09-16 用 `radar market observe --source hongguo --mode verify-sample --confirm-live` 对红果公共目录 `https://novelquickapp.com/category` 做了首次真实采样：抓到 24 部作品（origin=live），但暴露出两个清洗缺陷（证据记录在 `docs/product/global-market-radar.md` 已知限制段）：

1. **标题粘连**：红果目录 anchor 文本结构是「标题重复两遍 + 题材标签串」，例如 `夺风华夺风华古装重生逆袭日久生情` 应为 title=`夺风华`、题材标签=`[古装, 重生逆袭, 日久生情]`；现有 `splitTitle` 只剥离集数后缀，整串被原样存为 title，且 category 全为 null。
2. **category 覆盖 0/24**：真实页面没有在 parser 识别的 `h2/h3/h4` 小节标题里给出分类标签，标签串粘在 anchor 文本里；`field_coverage.category = 0/24`（`episode_count` 24/24 正常）。另有 32 条链接按 `no_work_identity` 被跳过、2 条按 `foreign_or_unsafe_link`，跳过归因需要复核解释。

在修复之前，红果样本不可作为 canonical 数据消费，也不能宣称类目观察已覆盖。

## What Changes

- 修正 hongguo HTML 解析：识别「标题×2 + 标签串」anchor 结构，拆出干净 title 与页面自带题材标签串；标签串经版本化映射 `market-label-mapping.v1`（zh 表）消费，未映射标签按既有合同保留原文入 evidence、topics 留空，禁止猜测题材。
- 新增**显式、版本化、仅 hongguo** 的 anchor 结构规则（命名 `hongguo-anchor-layout.v1`）；规则识别失败时标题保持原文，MUST NOT 发明标签。
- 标签串直接产生作品级题材标签（页面自带结构，不是 section heading）；section heading 继承逻辑保持不变。每个 anchor 去重后最多绑定 8 个标签。category/topic 覆盖率口径不变（`field_coverage.category` 仍以有题材标签的作品计数），fixture 上该覆盖率接近 100%，标题不再含重复串。
- 复核 32 条 `no_work_identity` 与 2 条 `foreign_or_unsafe_link` 的归因：解析器不做错误的 host/protocol 误判；真实原因（导航/播放/登录等非作品页链接、外链）写入 limitations，若发现身份提取缺陷则修复并给出去重后对比。
- 存量 24 条 live 观测与证据 payload 不可变、不改写；解析修正后由 owner 用 `--confirm-live` 显式重采样，生成新 batch/观测 revision，旧的粘连标题通过 candidate mapping 的后续 revision 更新（原 revision 保留）；`--fixture` 离线验证不改写 live 证据。
- hongguo readiness 保持 `planned`：本变更不晋级来源资格、不改变 observe 门禁（verify-sample/production 规则不变）、不生成 observe timer。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `radar-market-observations`：扩展红果目录解析要求——anchor「标题×2+标签串」结构拆分、页面自带标签的版本化映射消费、跳过归因解释与存量观测的重采样兼容策略。来源资格、幂等、人工/外部输入合同不变。
- `radar-market-agent-surface`：observe/import 回执的 `field_coverage` 与 `skipped_links` 语义保持既有字段并新增解释性 limitations；CLI help/输出合同不变。

## Impact

范围为 `src/market/catalog.ts`（解析与 anchor 结构规则）、`src/market/classification.ts`（如需为版本化映射补充已由页面证据支持的标签）、`test/fixtures/market/`（新增 2026-09-16 真实结构的脱敏夹具）、`test/unit/` 与 `test/integration/` 相关测试、`docs/product/global-market-radar.md` 已知限制段。不新增服务端、不改动其他来源解析器、不改变 readiness/资格算法、不做真实平台调用（除 owner 显式重采样）。
