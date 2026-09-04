# Scaena 工作区目录说明

本文件由 `scaena init` 创建，用来解释项目中的 Scaena 内部目录。当前项目使用 eager 兼容布局，空目录属于预创建结构。

## 使用边界

- 不要直接修改 `.scaena/` 中的结构化状态、数据库、receipt、manifest 或评审决定。
- 使用 `scaena` 命令或 Scaena 应用服务创建和更新这些内容。
- 剧本、创作笔记和其他普通源文件应放在 `.scaena/` 之外。
- `project.json` 保存工作区身份和基础配置，`index.sqlite` 保存权威本地投影与索引。

## 目录地图

| 目录 | 状态 | 用途 |
| --- | --- | --- |
| `.scaena/workflows/` | 预留 | 工作流定义、解析结果或可移植工作流文件；当前主要状态仍保存在 index.sqlite。 |
| `.scaena/matrix/` | 预留 | 实验矩阵选择和解析结果的本地镜像；普通 matrix 查询不要求这里已有文件。 |
| `.scaena/presets/` | 预留 | 可复用命令或生产参数预设的 CLI 管理镜像。 |
| `.scaena/packs/` | 按需 | 通过评估后可复用的场景、能力或生产 pack 文件。 |
| `.scaena/materials/` | 按需 | 导入素材的本地副本、来源信息或 material 投影。 |
| `.scaena/assets/` | 按需 | 生产资产的 CLI 管理工作区；资产元数据以 index.sqlite 为准，二进制内容放在 objects。 |
| `.scaena/objects/` | 使用中 | 按 SHA-256 寻址的本地二进制对象仓库，供图片、音频和视频资产复用。 |
| `.scaena/manifests/` | 使用中 | 由 Scaena 命令生成的资产、同步或导出 manifest。 |
| `.scaena/reviews/` | 按需 | 评审队列、评审决定或报告的文件投影；权威状态由 CLI 和 index.sqlite 管理。 |
| `.scaena/remotes/` | 按需 | 本地 mirror、同步目标和远端存储操作的工作目录。 |
| `.scaena/runs/` | 使用中 | 运行 receipt、脱敏日志、事件和运行产物。 |
| `.scaena/evidence/` | 使用中 | 质量检查、生成结果和交付判断所引用的脱敏 evidence 及附件。 |
| `.scaena/outcomes/` | 按需 | 真实生产 outcome、反馈和学习记录的可移植文件投影。 |
| `.scaena/recipes/` | 使用中 | 由服务生成的便携 workflow recipe（*.recipe.json）镜像。 |
| `.scaena/exports/` | 按需 | CLI 管理的导出暂存区和交付包；不要手工伪造 manifest。 |
| `.scaena/previews/` | 按需 | 本地预览媒体、预览 manifest 和装配检查产物。 |

## Agent 快速导航

1. 先读本文件判断目录用途；普通工作区问题不需要先搜索 Skills。
2. 用 `scaena --help` 或 `scaena <command> --help` 查找实际命令。
3. 自动化读取优先使用 `--json` 或 `--agent`，不要解析面向人的摘要输出。
4. 只有任务跨越 Auctra、Eikona、外部 provider、付费调用、主体冻结或生产验收 gate 时，才需要继续查对应 Owner/Skill 规则。

常用入口：

```bash
scaena workflow --help
scaena material --help
scaena asset --help
scaena production --help
scaena review --help
scaena export --help
scaena storage --help
scaena sync --help
```
