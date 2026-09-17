## Context

优先解决本人阅读标题的问题。31 条真实日语／韩语目录观测有可追溯作品与原文，类别、国家受众及形式仍未知；翻译不会补足这些事实。

## Decisions

标题是首个切片，不同时引入简介、整集字幕、OCR、配音或创作改写。源绑定摘要覆盖 work ref、原文、source ref 和源 locale；不绑定不断增加的采样证据数量，因此同原文重复采样不会反复让译文失效。写入时仍要求当前 mapping revision 和目标语言译文 revision，以拒绝陈旧编辑。

按 work/target/revision 追加行，key 唯一确保幂等。首次 revision=0，更正必须给 reason。简繁分别存储，不作无依据的字符替换。译文提交 method 为 agent/human，translator_ref 由提交者声明，均标 unreviewed 与 operator_reported，不能自称官方片名或独立审核完成。重放返回旧回执及 source_current，不把旧译文重新应用到新原文。

readTitleTranslation 报 missing/current/stale。current 仅表示原文摘要匹配，不等于翻译正确；missing/stale 显示原文并保留已有译文历史。当前内容政策先作用于原文观测 topics，译文不能带来新的分类或绕过 blocked。未知分类在限制策略下继续保守拒绝，聚合列表跳过不可读条目并报告 omitted。

reading list 是即时阅读投影，不改写已冻结 brief。默认简体，支持按 source 筛选，最多 100 条并明确 truncated；保留原文、译文、public_url、origin 和译文状态。底层复用现有个人映射 head 扫描，有量测瓶颈再建设分页索引，不新增服务或通用翻译平台。

无模型客户端时仍可工作：Agent 读取公开原文后通过 CLI 提交译文，读取只命中本地记录。模型、术语库、批量自动翻译及审核状态在将来实际需要时增量增加，不能为了等待它们阻塞个人阅读。原文和网页指令是数据，不作为 Agent 系统指令。

## 后续推进顺序

先用现有真实样本生成中原文对照，标明未译或有歧义项；再核验少量作品详情，解决格式、类别与语言来源。只有已存有可靠原文简介时才扩展简介翻译。作品去重、地区判断继续用原始标识与证据；个人收藏／关注优先复用既有合同，不卡在招募或实验流程。

## Verification

隔离测试覆盖原文不变、幂等、修订冲突、简繁隔离、原文变更失效、相同原文重采样继续复用、内容政策、秘密拒绝及真实 CLI 五种输出。新表显式排除 PG 同步，保留既有 allowlist 与迁移幂等。实际研究库通过 CLI 写入 Agent 译文并导出阅读投影；最终 typecheck、含真实 PG 的全量测试和 strict OpenSpec。
