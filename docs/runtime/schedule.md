# Radar 调度：OS 墙钟与 session 巡检

Radar 不内置调度引擎。墙钟采集走本机 OS 定时器；Claude / Grok 的 session 任务只消费 CLI 打出来的只读计划。

## 两层

| 层 | 做什么 | 不做什么 |
|---|---|---|
| OS（systemd / launchd / Task Scheduler） | 本地 08:10/08:30 collect、08:42 score、08:55/08:59 card | 不自动 enable；不把 session 成功当成已采集 |
| Session（Claude `/loop`、Scheduled Tasks；Grok `/loop`、`scheduler_create`） | 读 doctor / edition / brief，可选 `agent-reach watch` | 不跑 `radar collect`、`radar run`、`market observe --confirm-live` |

Grok 的间隔是 `1d` 这类 interval，不是「每天 08:10」。Claude `/loop` 随当前会话结束。Claude Scheduled Tasks（研究预览）是隔离会话 + cron，仍要 Claude 运行时在，不能替代 OS collect。

## 看计划

```bash
cd cli/short-drama-radar
bun run src/cli.ts schedule show --json
bun run src/cli.ts schedule install --backend auto --print
bun run src/cli.ts schedule session-plan --runtime both --json
```

`--backend auto`：linux → systemd，darwin → launchd，win32 → windows。

## Linux（现有行为）

```bash
bun run src/cli.ts schedule install
systemctl --user daemon-reload
systemctl --user enable --now short-drama-radar-collect.timer short-drama-radar-score.timer short-drama-radar-card.timer
systemctl --user list-timers 'short-drama-radar-*'
```

无 systemd 的容器里 doctor 的 `schedule` 为 blocked/unavailable，这是预期。改用下面的 session-plan，或到有 systemd/launchd/schtasks 的机器上装 OS 单元。

## macOS

```bash
bun run src/cli.ts schedule install --backend launchd
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.yeisme.short-drama-radar.collect.plist
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.yeisme.short-drama-radar.score.plist
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.yeisme.short-drama-radar.card.plist
launchctl print gui/$UID/com.yeisme.short-drama-radar.collect
```

旧系统可用 `launchctl load -w`。Radar 只写 plist，不代为 load。日志在 `~/.short-drama-radar/logs/`。

## Windows

```bash
bun run src/cli.ts schedule install --backend windows
schtasks /Create /TN "short-drama-radar-collect" /XML "%LOCALAPPDATA%\short-drama-radar\tasks\short-drama-radar-collect.xml" /F
schtasks /Create /TN "short-drama-radar-score" /XML "%LOCALAPPDATA%\short-drama-radar\tasks\short-drama-radar-score.xml" /F
schtasks /Create /TN "short-drama-radar-card" /XML "%LOCALAPPDATA%\short-drama-radar\tasks\short-drama-radar-card.xml" /F
schtasks /Query /TN "short-drama-radar-collect" /FO LIST /V
```

任务以当前用户 LeastPrivilege 运行，漏触发会补跑（StartWhenAvailable），同一任务重叠时忽略新实例。

## Session 计划（Claude / Grok）

```bash
bun run src/cli.ts schedule session-plan --runtime grok --json
bun run src/cli.ts schedule session-plan --runtime claude --json
```

把 `actions[].command` 交给当前 Agent。Grok 示例：

```text
/loop 1d You are a Radar session watcher. ...
```

Claude 当前会话用同样的 `/loop 1d ...`。若使用 Claude Scheduled Tasks，cron 在 `data.jobs[].claude_cron`（默认 `0 9 * * *` 只读晨检），prompt 必须自包含。

edition/cluster 仍不在 OS timer 里。出卡之后需要的话，在会话里显式运行：

```bash
bun run src/cli.ts cluster build
bun run src/cli.ts edition build --limit 8
```

## 不要做的事

- 不要手写 plist/XML/timer 当真源；改时刻走 config 再 `schedule install`。
- 不要把 Cookie、代理密码写进单元文件。
- 不要在 MCP 上调度 collect。
- 不要把 Agent Reach watch 的输出当成 Radar 市场资格已通过。
