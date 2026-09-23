## REMOVED Requirements

### Requirement: 安装必须按平台选择后端且不自动启用
单元生成与安装整体退役：Radar 不再产出 systemd / launchd / Windows 单元，`radar schedule install` 与 `radar market schedule install` 以 `command_retired` 拒绝；OS 定时器由客户侧自行创建与运维。

### Requirement: doctor 必须按本机后端诚实报告
doctor 不再探测 OS 单元与管理器；替换为"doctor 必须诚实报告客户侧调度事实"（见 ADDED）。

## ADDED Requirements

### Requirement: Radar 不得生成或安装 OS 调度单元
Radar MUST NOT 生成、写出或安装任何 OS 调度单元（systemd/launchd/Task Scheduler）。`radar schedule install` 与 `radar market schedule install` SHALL 以稳定错误码 `command_retired` 拒绝、零文件写入，错误信息指向客户侧接线文档。Radar MUST NOT 调用 enable/launchctl/schtasks，MUST NOT 在任何输出中声称自己已安装或启用了定时器。

#### Scenario: install 退役
- **WHEN** 用户运行 `radar schedule install --backend launchd`
- **THEN** CLI 以 `command_retired` 失败，不写任何文件，错误信息含客户侧接线文档路径

#### Scenario: market install 退役
- **WHEN** owner 运行 `radar market schedule install --print`
- **THEN** CLI 以 `command_retired` 失败，零写入，不输出任何单元文本

#### Scenario: 计划仍是建议值
- **WHEN** 用户运行 `radar schedule show --json`
- **THEN** 计划含默认墙钟时刻与命令，summary 声明墙钟执行为客户侧所有，actions 不含 install

### Requirement: 变更型命令必须自持运行锁
写库的管线命令 SHALL 在执行前获取 `${radarHome}/radar.lock` 独占运行锁：`run`、`collect`、`score`、`card`、`cluster build` 与 `market observe|analyze|brief|sync`。锁被存活进程持有时 MUST 等待（默认上限 600 秒，环境变量可覆盖），超限以稳定错误码 `lock_busy` 失败并携带持有者 PID；持有者进程已死或锁文件陈旧时 SHALL 接管；释放 MUST 只删除仍属于自己的锁。只读命令 MUST NOT 持锁。

#### Scenario: 重叠触发排队
- **WHEN** 一个 `radar run` 进行中，客户侧定时器又触发 `radar collect`
- **THEN** 第二个进程等待锁释放后继续执行，两者不并发写 SQLite

#### Scenario: 等待超限
- **WHEN** 锁被存活进程持有超过等待上限
- **THEN** CLI 以 `lock_busy` 失败，错误信息含持有者 PID 与命令，不写库

#### Scenario: 死锁接管
- **WHEN** 锁文件存在但持有者 PID 已不存在
- **THEN** 新进程删除陈旧锁并接管执行，无需人工清理

#### Scenario: 只读不加锁
- **WHEN** 用户运行 `radar edition show latest` 或 `radar market brief show`
- **THEN** 命令不获取运行锁，可与写命令并行读取

### Requirement: doctor 必须诚实报告客户侧调度事实
`radar doctor` 的 schedule 检查 SHALL 验证运行锁可用（零等待试取即释放）与计划投影可读，报告"墙钟调度为客户侧所有"。doctor MUST NOT 探测 OS 单元或管理器状态，MUST NOT 因单元未安装而报 blocked/unavailable，MUST NOT 输出任何启用命令。

#### Scenario: 无 OS 管理器的容器
- **WHEN** 在无 systemd/launchd/schtasks 的容器中运行 `radar doctor`
- **THEN** schedule 检查只反映锁与计划可用性，不因"单元未安装"降级

#### Scenario: 锁被持有
- **WHEN** doctor 运行时另一个 radar 写命令持有运行锁
- **THEN** schedule 检查为 degraded，detail 含持有者 PID，不尝试接管
