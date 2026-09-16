# Hermes 本地 canary runbook（M4 → 5.2）

单人 14 天 canary 的操作手册。验证主体是"用户 + Hermes 只读简报 + 显式反馈"这一循环；Radar CLI 侧的证据由 `radar health`、`radar runs` 与审计账本自动留痕。本 runbook 不含任何私人创作内容——记录表只存计数与 ref。

## 开始前：软件门与真实来源门

先在子项目目录完成软件验收（实现真源见 `openspec/changes/archive/` 下已归档的 establish-crawler-first-radar / personalized-radar-agent-experience-v1 / radar-pipeline-correctness-v1 及后续 change；spec 一致性由归档时 strict validate 保证）：

```bash
bun run typecheck
bun test
bun run test:integration
openspec list   # 应无 active change（或仅剩已知在途项）
```

> 前提注记：墙钟采集在 Linux 用 systemd user timer，macOS 用 LaunchAgents，Windows 用 Task Scheduler；`radar schedule install --backend auto` 只写单元，不启用。devcontainer/无 OS 调度器时 doctor 的 `schedule` 为 unavailable/blocked 属预期——可改用 `radar schedule session-plan` 做只读巡检，或按手动节奏逐日运行 collect/score/cluster/card/edition。session loop 不能代替 08:10 live collect。Linux 三服务已通过共享 flock + After/Wants 串行化。完整命令见 [runtime/schedule.md](../runtime/schedule.md)。

随后确认真实来源。`establish-crawler-first-radar` 的任务 6 以“后端已 provision、Agent Reach 可发现、适配器对离线/未登录显式降级”为完成标准；14 天 canary 的运行前置更严格：`agent-reach doctor --json` 中 `xiaohongshu.active_backend` 必须非空，且 `bun run src/cli.ts doctor --json` 中 `xhs-backend.status` 必须为 `ok`。未登录可以验证降级合同，但不能开始高质量 canary 窗口。

服务器方式先启动已配置的 MCP：

```bash
mkdir -p "$HOME/.agent-reach/xiaohongshu"
cd "$HOME/.agent-reach/xiaohongshu"
"$HOME/.agent-reach/tools/xiaohongshu-mcp" -headless=true -port 127.0.0.1:18060
```

在另一个终端扫码并复查：

```bash
mcporter call 'xiaohongshu.get_login_qrcode()' --timeout 120000
bun run src/cli.ts doctor --json
```

登录态文件必须留在用户级 `$HOME/.agent-reach/xiaohongshu/`，不得落入仓库。

## D1–D3：基线

1. `radar profile create --name <main> --topic ... --hook ... --blocked-topic ...` 建立主 Profile（必须显式设置 blocked topics 至少 1 项，用于验证硬过滤）。
2. 运行 `radar schedule install`，然后按输出执行 `systemctl --user daemon-reload` 与 `systemctl --user enable --now short-drama-radar-xhs.service short-drama-radar-collect.timer short-drama-radar-score.timer short-drama-radar-card.timer`。`systemctl --user status short-drama-radar-xhs.service` 应显示 active；`systemctl --user list-timers 'short-drama-radar-*'` 应显示 collect/score/card 三个 timer；再运行 `systemctl --user cat short-drama-radar-collect.timer short-drama-radar-score.timer short-drama-radar-card.timer | grep '^OnCalendar='`，确认共 5 个触发时间（08:10、08:30、08:42、08:55、08:59）。
3. 当前定时器只运行 collect、score 与兼容 card，不会代替个人 Edition builder。每天最后一次 card 触发后显式运行 `radar cluster build` 和 `radar edition build --limit 8`；只有拿到当天 edition ref 才算“按时生成”。
4. 每天 09:00 后运行 `radar health 3`，记录 days_with_collection、degraded_days、stable_id_violations。
5. 安装 [radar-personal-brief skill](./radar-personal-brief-skill.md)（reader lane），每天让 Hermes 出一次简报。

## D4–D7：机会与排序

1. 每天对 Edition 做显式反馈：`saved|used|dismissed|not_relevant|too_risky|already_seen`（经 Hermes curator 确认或 CLI 直填）。
2. 验证反馈只影响未来：`radar edition show <旧ref>` 的条目不得变化；新 Edition 才允许顺序变化。
3. 验证空榜诚实性：临时把 `--minimum-fit` 调到 99，确认空 Edition 的 limitations 说出真实原因，随后调回。

## D8–D14：连续 Edition 与通过门

1. 每天可记一行私人工作备注（只存计数/ref，不存内容）；正式量化证据由 `radar canary report 14 --json` 从 Edition、反馈和 Profile revision 真源生成，不手写结构化报告：

   | 日期 | edition_ref | status | 条目数 | saved | dismissed | used | 明显误报 | 备注 |
   | --- | --- | --- | --- | --- | --- | --- | --- | --- |

2. 通过门（AGENTS.md 14 天验证标准）：
   - ≥10 天有可审查 Edition；
   - 非空 Edition 中 ≥60% 至少一个 `saved|used`；
   - 明显误报/不可解释项 ≤25%；
   - 反馈只改变未来 Edition（抽查旧 ref digest 不变）；
   - 无秘密泄露（运行 `rg -n -i 'cookie|authorization|password|token|secret|api[_-]?key' temp/integration-test-runs/`，逐项确认只剩 `[REDACTED]` 或安全 schema/测试名称）、无跨 Profile 污染（第二 Profile 排序差异可由 reason codes 解释）、断线后无自动重放（审计账本无未经确认的 collect/daily_run success）。

3. 失败处理：任一门未过 → 记录原因到本表备注列，继续下一 14 天窗口；不得把收费、团队化或公共 Skill 当作修复手段。

4. 第 14 天执行最终证据检查：

   ```bash
   radar health 14 --json
   radar canary report 14 --json
   radar runs --json
   radar edition show latest --json
   radar audit tail --json
   radar doctor --json
   ```

   `health` 负责采集覆盖；`canary report` 自动计算 Edition 天数、非空日 usefulness、`not_relevant`/无 reason code 比例和 Profile 调整次数，并将 Hermes memory 冲突、秘密扫描和无自动重放保留为明确人工门；`audit tail` 负责人工确认 curator 反馈和无自动重放；`mcp capabilities` 在 5.2/5.3 尚未通过时必须继续把公共 Skill、remote endpoint 与 A2A 标为 `planned|unavailable`。

## 5.3：隔离 Profile 验证（canary 过门后）

1. 新建 5–8 个相互隔离 Profile（不同题材/预算/阈值）。
2. 同一天 `radar edition build --profile <ref>`，保存各 Profile 的 entry ref 序列。
3. 通过标准：排序差异能由 reason codes + profile revision 解释；同 Profile 重放顺序不变；历史 Edition 不变；无跨 Profile 泄露（一个 Profile 的反馈不改变另一个的同证据排序——分属不同 profile_ref 的 ledger 行）。

## 5.4：晋级决定（外部门）

Hermes 仅通过 Radar CLI 和用户级运行回执读取结果；不依赖 MCP、remote endpoint、A2A 或多用户服务。
