# Canary 就绪打磨：edition build 一次性 minimum-fit 覆盖 + runbook 修复

## Why

canary runbook D4-D7 要求"临时把 --minimum-fit 调到 99 验证空榜诚实性"，但 `--minimum-fit` 只是 `profile set` 的 flag——runbook 预期的 build 级临时覆盖不存在，只能通过 profile set 往返实现，产生 2 个额外 revision 并污染 canary 报告的 profileAdjustments 指标。另有两处 runbook 漂移：软件门引用已归档 change 名（strict validate 已不可运行）；未标注 systemd user manager 前提。

## What Changes

- `radar edition build --minimum-fit N`（0-100）：只影响当次构建——不写 profile revision；覆盖值记入 edition limitations（"admission threshold overridden for this build only"）与命令 facts（`minimum_fit_override`）；纳入输入指纹（与幂等协同：同输入+同覆盖→同 Edition）
- runbook 软件门改为现行命令形态（typecheck/test/integration/openspec list）+ 归档真源指引
- runbook 补 systemd 前提注记（flock/After=Wants 串行化已由 radar-pipeline-correctness-v1 落地）

## Impact

editionBuildAction 输入与 facts 各增一个可选字段；radar.morning_edition.v1 合同字段零变化（limitations 复用既有 string list）；profile 真源不受影响。
