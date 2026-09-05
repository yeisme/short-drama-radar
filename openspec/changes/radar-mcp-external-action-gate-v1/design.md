# Design

Reader/curator 保持默认 surface。MCP 不再代理外部采集和完整 daily pipeline；CLI/systemd 继续作为 owner-controlled 执行入口。本地写 profile 由启动参数显式选择。

## Deferred

- 可见 mutation 的幂等性（`edition_build`/`score` 自然键去重与 reused 审计）移交独立 change `radar-mutation-idempotency-v1`；本 change 只收敛发现面与外部动作门。
- `radar://sources/status` 的本地化实现超出原提案范围但属本 change 精神（外部读取副作用不进 MCP）：资源改为本地检查 + 最近采集回执，实时探测 CLI-only。
