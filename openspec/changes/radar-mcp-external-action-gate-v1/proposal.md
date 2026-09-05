# Short Drama Radar MCP 外部动作收敛

## Why

`collect` 与 `daily_run` 可产生外部读取/写入副作用，仅靠 host confirmation 文字不足以构成权限边界。

## What Changes

- `collect`、`daily_run` 本轮改为 CLI-only。
- 其他本地写操作仅在显式 operator profile 可见。
- 可见 mutation 要求 idempotency 与持久审计。

## Impact

影响 MCP catalog/profile 和 e2e tests，不移除 CLI 调度能力。
