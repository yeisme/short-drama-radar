# radar-cross-platform-schedule Specification

## ADDED Requirements

### Requirement: 可移植任务图必须区分墙钟与会话

系统 SHALL 从同一 `radar.schedule.plan.v1` 派生 OS 单元与 session 计划。`collect`/`score`/`card` MUST 标记为 `wall_clock`；只读巡检 MUST 标记为 `session_read`。系统 MUST NOT 把 session 循环登记为墙钟采集成功。

#### Scenario: 默认 pipeline 时刻
- **WHEN** 使用默认 config 构建计划
- **THEN** collect 为 08:10 与 08:30，score 为 08:42，card 为 08:55 与 08:59（本地时刻）

### Requirement: 安装必须按平台选择后端且不自动启用

`radar schedule install` SHALL 接受 `--backend auto|systemd|launchd|windows`。`auto` 在 linux 选择 systemd、darwin 选择 launchd、win32 选择 windows。写入用户级单元后 MUST 只打印启用命令，MUST NOT 调用 enable/bootstrap/schtasks create，MUST NOT 使用 sudo。

#### Scenario: Linux 默认兼容
- **WHEN** 在 linux 上运行 `radar schedule install --print` 且未传 backend
- **THEN** 输出既有 systemd user unit，collect timer 仍含两行 OnCalendar，服务仍用 flock 与 `--json`

#### Scenario: macOS 生成 LaunchAgent
- **WHEN** `--backend launchd --print`
- **THEN** 生成 `com.yeisme.short-drama-radar.collect|score|card` plist，含对应 StartCalendarInterval，且不含 cookie/token/password

#### Scenario: Windows 生成任务 XML
- **WHEN** `--backend windows --print`
- **THEN** 每个墙钟任务有日历触发、`StartWhenAvailable=true`、`MultipleInstancesPolicy=IgnoreNew`，动作调用 Radar CLI `--json`，且不含秘密

### Requirement: doctor 必须按本机后端诚实报告

`radar doctor` SHALL 探测当前平台对应的已安装单元与管理器。文件已写但管理器不可用 MUST 为 `blocked`；未安装 MUST 为 `unavailable`。系统 MUST NOT 在无管理器的容器中报告 schedule=ok。

#### Scenario: 无 systemd 的 Linux 容器
- **WHEN** timer 文件存在但 `systemctl` 不可用
- **THEN** `schedule` 为 blocked/unavailable，并给出 `radar schedule session-plan` 或本机 OS 启用命令
