# 中文标题阅读机制

首版让本人直接阅读已有外语目录，支持简体 zh-Hans 与繁体 zh-Hant。译文由 Agent 或人工通过 Radar CLI 提交，读取使用本地记录，不自动调用模型或产生翻译服务费用。它是辅助译名，不是官方中文片名；当前全部标为 unreviewed，method/translator_ref 是提交者声明。

## 已实现的边界

原文标题、作品 ID、别名、来源证据、地区、形式、题材、排名及反馈都不被译文覆盖。新译文单独追加历史，与 work、原文、来源和源语言摘要绑定。相同原文再次采样不会重复失效；原文或源语言变化后显示 stale 并退回原文。旧请求重放返回原回执，不重新激活已过期内容。

简繁各自保存。没有繁体译文就保留原文，不能把简体记录换个标签当繁体。current 只表示与原文绑定匹配，不表示译名已经审核正确。人名、身份、关系和双关无法确定时不补剧情，保留原文并等待详情核验。

第一版只翻译标题，不翻译完整剧集或生成字幕，不借翻译推断作品是动画。网页中的指令只是来源文本，不能成为执行命令。当前内容策略先作用于原文；不可读内容不能通过中文绕过限制。译文表留在本地，不进入现有 PG 归档允许表。

## 使用方式

从 Radar 子项目目录运行。先读取真实作品引用及修订：

```bash
bun run src/cli.ts market work list --json
bun run src/cli.ts market translation show --work "$WORK_REF" --language zh-Hans --json
```

首次提交使用译文 revision 0；work-revision 来自当前作品：

```bash
bun run src/cli.ts market translation add --work "$WORK_REF" --work-revision "$WORK_REVISION" \
  --revision 0 --language zh-Hans --text '中文辅助译名' \
  --method agent --translator session-review --key "$TRANSLATION_KEY" --json
```

更正时使用当前译文修订、新 key，并加 `--reason 'Correct the title interpretation'`。原文改动后先读取新 work revision，再提交新译文；不要覆盖旧记录。`translation show --revision` 可查历史。

按来源阅读中原文：

```bash
bun run src/cli.ts market reading list --language zh-Hans --source reelshort-ja --limit 20 --json
bun run src/cli.ts market reading list --language zh-Hant --source reelshort-ko --limit 20 --json
```

默认列表展示简体，最多 100 条，超出明确 truncated；不承诺当前已实现完整分页。每条保留 original_title、display_title、public_url、origin、status 和译文历史引用。缺失／过期均使用原文；列表省略政策禁止或缺少匹配原文证据的条目，并报告 omitted。现有冻结 brief 不被翻译追溯改写。

## 真实样本演练

在上一轮独立研究库 `temp/reelshort-localized-live-r9BW0y/` 中，本次通过 CLI 给 30 条真实原文目录标题各提交简体、繁体译文，共 60 条未审核记录；另 1 条标题语境不明，保留 missing。没有再抓取网页，也没有增加来源资格。

该目录的 `reading-zh-Hans.json`、`reading-zh-Hant.json` 是 CLI 阅读投影；对应 `.md` 是由该投影生成的中原文对照，方便直接阅读。译文属于 Agent 解释，可能需要根据作品详情修订，尤其是专有名词和关系歧义。它们不被当作消费者反馈。

要读取这个演练库，明确选择它而不是默认个人库：

```bash
RADAR_HOME="$PWD/temp/reelshort-localized-live-r9BW0y" \
RADAR_DB_PATH="$PWD/temp/reelshort-localized-live-r9BW0y/radar.db" \
RADAR_CONFIG_PATH="$PWD/temp/reelshort-localized-live-r9BW0y/config.json" \
bun run src/cli.ts market reading list --language zh-Hans --limit 100 --json
```

演练操作已由现有集成证据 runner 记录，原文与样本库保留；没有改用户默认 Profile 或开启批量后台任务。该结果只说明中文阅读合同可运行，不证明译文已经经母语者审核。

## 后续推进

先根据自己的实际阅读纠正歧义标题；然后挑少量作品核验详情、类别和形式，取得原文简介后才扩展简介翻译。中文阅读入口继续按来源组织，不强行把日语／韩语目录算成 JP/KR 观众热榜。

接着补齐个人范围内 HK/TW 等地区注册缺口，再改善收藏／关注／补看中的阅读呈现。需要 DSH 界面时让 DSH 消费现有投影，不在 Radar 增加独立 UI。只有手工提交反复成为瓶颈时才增量设计模型适配器、费用控制与术语库；当前无需等待这些能力即可使用。全程不恢复招募或受众实验。

本轮验证：375 项测试通过、零失败、零跳过，含真实 PostgreSQL；类型检查与 strict OpenSpec 通过。软件证据：`temp/integration-test-runs/2026-09-17T02-49-56-066Z-d6aa7f/`。实际译文 CLI 操作与重放证据：`temp/integration-test-runs/2026-09-17T02-48-14-000Z-9si5vr/`。
