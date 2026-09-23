# Design

## 决策背景

三个平台单元生成器（systemd/launchd/Windows XML + market 单元）从不自动启用，唯一产出是单元文本与 next-steps 提示；维护按三平台×golden 测试持续付费。用户裁决定时任务归客户侧，因此整面退役，而不是继续"只打印不安装"。

## 退役面

- `radar schedule install [--backend ...] [--print]` → `command_retired`，零写入。不保留 `--print` 模板打印：模板本身就是维护负担，客户侧接线示例进文档，不再按平台锁定形状。
- `radar market schedule install [--print]` → 同上。
- `schedule show` 的 actions 不再列 install；summary 改为"计划为建议值，墙钟执行客户侧所有"。
- 保留 `schedule.*` config 时刻：`schedule show` 与文档仍需要建议值；校验逻辑（HH:MM）不变。

## 运行锁（新增 src/runlock.ts）

退役前串行保障在生成单元的 `ExecStart=/usr/bin/flock -w 600 ~/.short-drama-radar/radar.lock`；macOS/Windows 单元本来就没有跨命令 flock（只有单任务 IgnoreNew）。客户侧接线后，唯一可靠的串行点在 CLI 本体：

- 锁文件 `${radarHome}/radar.lock`，与退役单元同路径：已在 flock 外层包装的客户不破坏，直接调用的客户获得内建保障。
- 协议：`writeFileSync(path, body, { flag: "wx" })` 独占创建；body 为 JSON `{pid, command, startedAt}`。EEXIST 时读持有者：pid 存活且未超等待上限 → 250ms 轮询；pid 已死 → 删除接管；超上限 → `lock_busy`（携带 pid/command/startedAt）。
- 默认等待 600s（对齐 `flock -w 600`）；`RADAR_LOCK_WAIT_MS` 环境变量可覆盖（上限 3_600_000）。
- 释放只删除内容仍属于自己的锁文件（防释放被接管的锁）。
- 加锁范围＝退役单元原本覆盖的写命令：`run|collect|score|card|cluster build` 与 `market observe|analyze|brief|sync`。`market host-serve`（长驻读服务）与交互单发命令（profile/feedback/edition）不加锁——SQLite `busy_timeout=5000` 已覆盖短重叠。
- 锁在 CLI 分发层获取一次；`run` 内部直接调用 collect/score/card 动作，不经过分发层，无重入死锁。

## doctor

schedule 检查不再探测 systemd/launchd/schtasks 与单元文件。新行为：零等待试取运行锁→释放，成功即 `ok`（detail：调度客户侧所有，见接线文档）；被持即 `degraded`（携带持有者 pid）；锁目录不可写即 `blocked`。doctor 不再输出任何"启用命令"。

## 文档

docs/runtime/schedule.md 重写为客户侧接线指南：计划时刻（默认 08:10/08:30/08:42/08:55/08:59，`schedule show` 可查）+ 三平台接线示例（Linux cron 与 systemd 二选一、macOS launchd plist、Windows schtasks）+ 运行锁语义说明（重叠触发排队等待，10 分钟上限后 `lock_busy`）。示例中的命令一律是 `radar <cmd> --json`，不承诺 Radar 代写单元。

## 兼容性

- 单人私有工具（private、v0.0.1、未发布），命令移除以显式 `command_retired` 错误码过渡而非静默 unknown_command，错误信息直接给出文档路径。
- `command_retired` 为新错误码，加入稳定错误码集合；不改动既有错误码语义。
- 已安装的旧单元（若有）不受影响：它们调用的 CLI 命令（collect/score/card/market…）全部保留，flock 外层与内建锁叠加无害。
