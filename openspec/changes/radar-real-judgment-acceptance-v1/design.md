# Design

## Owner 与兼容

领域源读取通过当前产品 CLI；领域入口固定 owner 和用户级 store，DSH 通过受控 argv 调用，不能指定任意 executable、文件路径或 owner store。新增验收回执不替换旧 judgment evidence，source_digest 与 request_id 绑定反馈，重放幂等。业务采纳始终沿用原服务。

## 安装与分发

Aigora tools/judgment-acceptance 下公共 QA runtime 通过 install.py 安装到用户目录；本项目仅 opt-in scripts/judgment-acceptance.py 消费。不是 SDK 核心的持久化职责，也不引入新的平台项目。无安装时显式不可用；不假装普通主 CLI 已内置该命令。

## 冲突处理

1. 索引/CLI 版本不兼容：在 owner 建立只读兼容投影，验证支持的旧字段；拒绝新于读取器的 schema。不得为读取自动迁移原库。
2. 有数据无安全读取入口：补 owner 的最小 allowlist projection；DSH 不读取 SQLite 或任意文件。
3. 无授权数据/查询：明确 missing_data；不新建合成案例冒充真实任务。
4. 统计不足：显示真实分母与遗漏原因，用户未复核保持待验收。

## Verification

脚本 inventory/show 默认不调用模型；run 限 3/20 累计目标，已执行 attempt 不再提交。全局预算/并发/未知结果暂停归 Aigora。用户补充反馈属于 owner sidecar 状态，测试必须使用隔离 store；禁止用测试标签污染真实验收结果。
