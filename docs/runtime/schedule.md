# Radar 调度：客户侧接线（customer-owned wiring）

Radar 不内置调度引擎，也不生成、不安装、不启用任何 OS 调度单元（`radar schedule install` 与 `radar market schedule install` 已于 2026-09-23 退役，见 OpenSpec `radar-scheduler-retirement-v1`）。Radar 只提供 CLI；什么时候跑由你在客户侧决定（cron / launchd / Task Scheduler / Agent 运行时都可以）。重叠触发是安全的：所有写库命令内建跨进程运行锁。

## 建议时刻表

`radar schedule show --json` 输出建议计划（本地时区）：

| 时刻 | 命令 | 说明 |
|---|---|---|
| 08:10 | `radar collect --json` | 第一轮采集 |
| 08:30 | `radar collect --json` | 第二轮采集（传播增速需要同日两次观测做差，不能伪造） |
| 08:42 | `radar score --json` | 评分 + 聚类 + 个人重排 |
| 08:50 | `radar market analyze --json` | 市场面：分析上一完整日 |
| 08:55 | `radar card --json` | 冻结 card.v1 卡片 |
| 09:00 | `radar market brief build --json` | 冻结每日市场简报 |
| 09:10（可选） | `radar market sync --to pg --json` | PG 归档，默认手动 |

一次跑全也可以：`radar run --json` = collect → score → cluster → card + edition。

## 运行锁（无需你做任何事）

`run`、`collect`、`score`、`card`、`cluster build` 与 `market observe|analyze|brief|sync` 在执行前获取 `~/.short-drama-radar/radar.lock`：

- 被存活进程持有时排队等待，默认上限 600 秒（`RADAR_LOCK_WAIT_MS` 可调，上限 3600 秒）；
- 超限以稳定错误码 `lock_busy` 失败，错误信息含持有者 PID；
- 持有者进程崩溃后新进程自动接管陈旧锁；
- 只读命令（edition show、market brief show 等）不加锁，可与写命令并行。

因此两种触发重叠（比如 collect 还没跑完 score 已到点）会排队执行，不会并发写 SQLite。macOS / Windows 上此保障同样生效——锁内建于 CLI，与平台定时器无关。

## Linux 接线

cron（最简）：

```cron
10 8 * * *  radar collect --json
30 8 * * *  radar collect --json
42 8 * * *  radar score --json
50 8 * * *  radar market analyze --json
55 8 * * *  radar card --json
0  9 * * *  radar market brief build --json
```

或 systemd user timer（你自己拥有这份文件，Radar 不代写）：

```ini
# ~/.config/systemd/user/short-drama-radar-collect.service
[Unit]
Description=short-drama-radar: collect pass
[Service]
Type=oneshot
# 外层 flock 可选：CLI 已内建同一把锁；加上可与旧习惯兼容
ExecStart=/usr/bin/flock -w 600 %h/.short-drama-radar/radar.lock /usr/local/bin/radar collect --json
```

```ini
# ~/.config/systemd/user/short-drama-radar-collect.timer
[Unit]
Description=short-drama-radar: collect at the two morning passes
[Timer]
OnCalendar=*-*-* 08:10:00
OnCalendar=*-*-* 08:30:00
Persistent=true
Unit=short-drama-radar-collect.service
[Install]
WantedBy=timers.target
```

score/card/market 各自仿照（时刻见上表）。启用：

```bash
systemctl --user daemon-reload
systemctl --user enable --now short-drama-radar-collect.timer short-drama-radar-score.timer short-drama-radar-card.timer
systemctl --user list-timers 'short-drama-radar-*'
```

## macOS 接线

cron（macOS 自带，最简）：

```cron
10 8 * * *  /usr/local/bin/radar collect --json
30 8 * * *  /usr/local/bin/radar collect --json
42 8 * * *  /usr/local/bin/radar score --json
55 8 * * *  /usr/local/bin/radar card --json
```

或 LaunchAgent（`~/Library/LaunchAgents/com.yeisme.short-drama-radar.collect.plist`，自己维护）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.yeisme.short-drama-radar.collect</string>
  <key>ProgramArguments</key><array>
    <string>/usr/local/bin/radar</string><string>collect</string><string>--json</string>
  </array>
  <key>StartCalendarInterval</key><array>
    <dict><key>Hour</key><integer>8</integer><key>Minute</key><integer>10</integer></dict>
    <dict><key>Hour</key><integer>8</integer><key>Minute</key><integer>30</integer></dict>
  </array>
  <key>StandardOutPath</key><string>/tmp/radar-collect.log</string>
</dict></plist>
```

```bash
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.yeisme.short-drama-radar.collect.plist
```

## Windows 接线

任务计划程序（schtasks，直接调用 CLI，无需 XML）：

```powershell
schtasks /Create /TN "short-drama-radar-collect-1" /SC DAILY /ST 08:10 /TR "radar collect --json"
schtasks /Create /TN "short-drama-radar-collect-2" /SC DAILY /ST 08:30 /TR "radar collect --json"
schtasks /Create /TN "short-drama-radar-score" /SC DAILY /ST 08:42 /TR "radar score --json"
schtasks /Create /TN "short-drama-radar-card" /SC DAILY /ST 08:55 /TR "radar card --json"
schtasks /Query /TN "short-drama-radar-collect-1" /FO LIST /V
```

任务以当前用户 LeastPrivilege 运行。重叠触发由 CLI 运行锁排队，不依赖 `MultipleInstancesPolicy`。

## Session 计划（Claude / Grok）

```bash
radar schedule session-plan --runtime grok --json
radar schedule session-plan --runtime claude --json
```

把 `actions[].command` 交给当前 Agent：Grok/Claude 当前会话用 `/loop 1d ...`；Claude Scheduled Tasks 用 `data.jobs[].claude_cron`（默认 `0 9 * * *` 只读晨检），prompt 必须自包含。Session 巡检只读（doctor/edition/brief），不跑 collect，不冒充墙钟采集。

edition/cluster 仍不在建议时刻表里。出卡之后需要的话显式运行：

```bash
radar cluster build
radar edition build --limit 8
```

## 不要做的事

- 不要让任何工具替你"安装"Radar 定时器——`schedule install` 已退役，接线是你的动作。
- 不要把 Cookie、代理密码写进 cron 行、plist、任务描述或脚本仓库。
- 不要在 MCP 上调度 collect。
- 不要把 Agent Reach watch 的输出当成 Radar 市场资格已通过。
- doctor 的 `schedule` 检查只报告运行锁可用性，不代表你已接线定时器。
