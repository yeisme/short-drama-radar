## MODIFIED Requirements

### Requirement: 与调度器的关系必须显式且默认不启用

Radar MUST NOT 生成、写出或启用任何调度单元（含 sync 定时器）。`radar market schedule show` MUST 把 sync 列为可选挂接并注明接线由 owner 在客户侧自行完成；`radar market schedule install` MUST 以 `command_retired` 拒绝且零写入。同步 MUST NOT 进入 cutoff/freeze 语义。

#### Scenario: 安装调度单元
- **WHEN** owner 执行 `radar market schedule install`
- **THEN** CLI 以 `command_retired` 失败，零文件写入，错误信息指向客户侧接线文档（Radar 不再产出任何调度单元）

#### Scenario: sync 定时由 owner 自建
- **WHEN** owner 想让 `radar market sync --to pg` 定时执行
- **THEN** owner 在客户侧自行创建定时器（文档提供示例），RADAR_PG_URL 仍只来自用户环境变量或用户级配置，不进入任何 Radar 生成的文件
