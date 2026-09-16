# 本地立项决策与实验闭环

## Why

现有研究包仍是普通文档，不能提供应用生成的决策修订、实验锁定和结果回顾。用户已要求继续设计 goal 并实现代码。本变更把这些行为落在 Radar，不用手写元数据替代应用状态。

## What Changes

- 新增 `radar decision` 命令组：创建／查看／列举、证据和候选、基线、实验锁定、结果修订、回顾与显式恢复。
- 新增三个 append-only SQLite 表，经 Drizzle 访问；复用标准输出、市场内容禁区及当前 Profile 隔离。
- 实验冻结候选、阈值、样本和招募／预算说明；结果保存人工报告与 fixture 的区别，缺失基线或意愿调查不能证明方法优势。
- 支持同键同参重放、陈旧修订拒绝、两轮不达标后暂停新实验并要求显式复查。

## Capabilities

### New Capabilities
- `radar-decision-pilot`: 决策包、局部实验锁定、结果和回顾。

### Modified Capabilities
无。原 card、Profile、Edition、assignment、used、canary 与 PG 归档表集合不变。

## Impact

owner 为 cli/short-drama-radar。CLI、输出 data、数据库均为 additive；首轮不增加 MCP、远端服务、投放、生成或用户招募。代码在当前工作区单写者实施，测试使用内存库及临时 RADAR_HOME，保留既有未提交工作。
