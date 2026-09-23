# Proposal

## Why

用户裁决（2026-09-23）：Radar 面向 macOS / Windows 继续可用，但不再自己维护 OS 调度运维——Radar 只提供一个 CLI，定时任务交给客户侧（用户自己的 cron / launchd / Task Scheduler / Agent 运行时）处理。现状是 Radar 为三个平台生成并写出调度单元（systemd/launchd/Windows XML + market 单元），每平台一套模板、golden 测试与 next-steps 运维说明；这套生成器从未自动启用定时器，实际价值只剩"打印单元文本"，维护成本却按三平台持续支付。单元退役后，原先内嵌在生成单元里的 `flock` 串行保障消失，必须把跨进程互斥移进 CLI 本体，否则客户侧定时器重叠触发会并发写同一 SQLite。

## What Changes

- 退役 `radar schedule install`（全部 backend）与 `radar market schedule install`：以稳定错误码 `command_retired` 拒绝、零文件写入，错误信息指向客户侧接线文档；删除 systemd / launchd / Windows 单元生成器与对应 golden 测试。
- 保留只读面：`radar schedule show`（计划投影，含默认时刻）、`radar schedule session-plan`（会话巡检投影）、`radar market schedule show`（市场计划说明）——全部不再指向 install。
- 新增 CLI 内建跨进程运行锁（`${radarHome}/radar.lock`，与退役单元使用的锁路径一致）：`run|collect|score|card|cluster build` 与 `market observe|analyze|brief|sync` 在执行前获取；被活进程持有时等待（默认上限 600s，与退役的 `flock -w 600` 对齐）后以 `lock_busy` 失败并携带持有者 PID；持有者已死可接管；只释放自己的锁。
- `radar doctor` 的 schedule 检查改为诚实报告客户侧事实：验证运行锁可用与计划投影可读，不再探测 OS 单元/管理器，也不在任何输出中声称 Radar 已安装或启用定时器。
- 新增客户侧接线文档（docs/runtime/schedule.md 重写）：Linux cron / systemd、macOS launchd / cron、Windows Task Scheduler 直接调用 CLI 的示例，说明运行锁使重叠触发排队等待而非并发写库。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `radar-cross-platform-schedule`：移除单元生成/安装与 doctor 管理器探测需求；新增"不得生成或安装 OS 调度单元""变更型命令必须自持运行锁""doctor 必须诚实报告客户侧调度事实"。
- `radar-cli-agent-contract`：命令面合同中 `schedule install` 改为退役拒绝；`schedule show` / `session-plan` 不变。
- `radar-session-schedule`：doctor 场景不再依赖 OS 单元探测，语义改为"未接线客户侧定时器时不得声称已调度采集"。
- `radar-market-pg-config-safety`：调度器关系改为"Radar 不生成任何单元；sync 定时由 owner 自行接线"，`market schedule install` 退役。

## Impact

src/cli.ts、src/schedule.ts、src/schedule-launchd.ts（删除）、src/schedule-windows.ts（删除）、src/diagnostics.ts、src/market/schedule.ts、src/market/cli.ts、新增 src/runlock.ts；test/unit/schedule-backends.test.ts 与 test/unit/market-schedule.test.ts 删除，schedule-health/secrets 等测试适配，新增 runlock 测试；docs/runtime/schedule.md 重写为客户侧接线指南，docs/product/global-market-radar.md、docs/hermes/canary-runbook.md、AGENTS.md 跟随更新。不新增依赖、数据表或网络面；Profile/Edition/card 合同不变。配置 `schedule.*` 时刻保留，作为 `schedule show` 的建议值供客户侧镜像。
