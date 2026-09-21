# 实施与验收任务

由 scripts/openspec-tasks.py 维护状态。

- [x] 1.1 盘点真实 source 与现有 consumer 缺口，保留 typed gap | evidence: 真实库 zh-Hans 阅读列表为空（0 条）；隔离 store 经 offline-live 观测产出 origin=live 条目后 collect 仅收 live 行并保留 typed gaps（reading_context_title_only、no_active_personal_profile）；无来源时 inventory 返回 typed gap、零 provider call、不生成替代样本。
- [x] 1.2 实现 owner-bound 采样、SDK 调用和反馈持久化并完成离线验证 | evidence: scripts/judgment-acceptance.py + 共享 runtime（与 Aigora 源 md5 一致）离线验证 35/35 断言通过：真实 CLI shim 采样、case 形状/digest、inventory/show 零模型调用、mock evaluator run 每案一次且重放不重提、unknown 粘滞、review 幂等回执/冲突与过期拒绝/business_adoption=false/user_reviewed 终态；隔离 store 全在 temp/，无网络无凭据；证据 temp/integration-test-runs/2026-09-21T18-45-56-502Z-2453sq。
- [ ] 1.3 执行首批真实案例；来源不足或待用户复核时不宣称效果通过。
