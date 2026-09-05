# Design

## 为什么不需要新 DDL

原计划为 (profile_ref, date, revision, fingerprint) 建唯一索引。实现时发现 `morning_editions.edition_ref` 已有 UNIQUE 约束，而确定性 editionRef 恰好编码了同一自然键（profile|revision|fingerprint|date）——直接预查 editionRef 即可命中复用，避免迁移与存量去重。

## 指纹内容

ranked 输入元组（ref/marketScore/evidenceConfidence/degraded/personalFit）+ limit。反馈调整改变 personalFit → 指纹变化 → 新 Edition（反馈只影响未来的不变量保持）。阈值随 profile revision 变化 → ref 变化。`radar run` 与显式 `radar edition build` 同输入得到同一 edition（CLI 冒烟已验证）。

## score/cluster 回执身份

score 的指纹取打分结果行（contentId/score/confidence/isNew/tags 排序哈希）：F6 确定性保证同数据同结果同指纹。cluster 指纹取重建结果计数。存在即跳过插入（recordRun 的碰撞兜底不会触发）。
