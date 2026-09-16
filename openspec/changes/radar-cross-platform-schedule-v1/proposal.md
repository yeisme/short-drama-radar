# radar-cross-platform-schedule-v1

## Why

当前 `radar schedule install` 只生成 Linux systemd user timer。macOS、Windows、无 systemd 的容器都不能诚实对接；Agent Reach 的 watch 也只在 OpenClaw cron 里被提到。同时，Claude Code 已有 session 内 `/loop` 与预览中的 isolated Scheduled Tasks，Grok 已有 `/loop` 与 `scheduler_create`。Radar 不应再造一套调度引擎，但必须把「墙钟采集」和「会话巡检」分成两层，并给 Mac/Windows 生成可安装单元。

## What Changes

- 抽出可移植任务图 `radar.schedule.plan.v1`：collect/score/card 为墙钟 pipeline；doctor/edition/brief/watch 为 session 只读。
- `radar schedule install --backend auto|systemd|launchd|windows`：Linux 默认 systemd（现有单元文本不断代），macOS 写 LaunchAgents，Windows 写 Task Scheduler XML。写入仍不自动启用。
- `radar schedule show` 与 `radar schedule session-plan`：后者只打印 Claude/Grok 可直接使用的 `/loop`、Scheduled Task 与 `scheduler_create` 载荷，不在 Radar 进程内跑循环。
- `radar doctor` 按本机平台探测对应后端；无 OS 调度器时指向 session-plan，不得声称已经在跑。
- 市场 observe timer 仍 planned。市场 analyze/brief 的非 systemd 后端可同图生成，但不替换现有 market 单元合同。

## Capabilities

### New Capabilities

- `radar-cross-platform-schedule`
- `radar-session-schedule`

### Modified Capabilities

- `radar-cli-agent-contract`：新增 `schedule show|session-plan` 与 `--backend`（加法）。
- `radar-pipeline`：调度安装从「仅 systemd」扩展为按平台选择后端；Linux systemd 行为保持。

## Non-goals

- 不在 Radar 内实现 Claude/Grok/Codex 调度器、不常驻 daemon、不云端 cron。
- 不把 session loop 当成 08:10 采集的替代；会话关闭或间隔计时都不能冒充墙钟成功。
- 不自动启用 OS timer，不写凭据进 plist/XML，不用 sudo。
- 不新建跨项目调度服务，不把 Agent Reach 变成 Radar 真源。

## Impact

`src/schedule.ts`、新生成器、`diagnostics.ts`、CLI、docs、unit tests。`short-drama-radar.card.v1` 与现有 systemd 单元文本保持兼容。
