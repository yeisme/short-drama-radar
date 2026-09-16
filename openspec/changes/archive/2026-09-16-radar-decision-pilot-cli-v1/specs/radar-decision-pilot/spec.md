## ADDED Requirements

### Requirement: CLI 创建不可变决策历史
Radar SHALL 通过应用命令创建决策包、证据、候选和基线修订，保证幂等、具名 Profile 隔离与当前内容策略。

#### Scenario: 重试和陈旧写入
- **WHEN** 同命令键与标准化参数重放
- **THEN** 返回原修订且不新增写入
- **AND** 同键异参或陈旧修订失败且无部分写入

#### Scenario: 策略变化
- **WHEN** 包受当前禁区阻止或属于其他具名 Profile
- **THEN** 读取、重放、实验和结果不得暴露其内容

### Requirement: 明确基线并冻结本地实验
Radar SHALL 区分缺失基线与人工声明的独立基线，在记录结果前冻结本地实验条件。

#### Scenario: 缺失基线
- **WHEN** 方法对照缺少在候选建立前记录的独立基线
- **THEN** 锁定失败且不创建实验
- **AND** 候选假设实验允许明确保留缺失基线

#### Scenario: 冻结输入
- **WHEN** 锁定后修改决策包
- **THEN** 原实验保留候选、阈值和包摘要
- **AND** 结果不得声称在锁定前开始观察

### Requirement: 可回查结果和有限复盘
Radar SHALL 把结果更正保存为新修订，仅对符合条件的观测给出方向性支持，不将意愿、fixture 或缺失数据转为受众成功。

#### Scenario: 不合格观测
- **WHEN** 输入为 fixture、仅意愿、不完整或不可比
- **THEN** 回顾返回 inconclusive 和明确原因

#### Scenario: 重复不达标后暂停
- **WHEN** 同协议两轮完成后未达到设定门槛
- **THEN** 新实验需要显式复查恢复决定
- **AND** 假设实验不得证明 Radar 选题方法优越

### Requirement: 增量 CLI 和存储
Radar SHALL 保留既有合同与数据，同时为 decision 提供标准 summary、JSON、agent、explain 和 events 投影。

#### Scenario: 旧数据库与消费者
- **WHEN** 新版本打开旧数据库
- **THEN** 新建决策表而不修改旧行
- **AND** 旧命令与标准 envelope 保留原义
