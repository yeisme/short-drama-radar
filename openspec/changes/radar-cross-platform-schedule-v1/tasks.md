# 任务

## 1. 任务图与 OS 生成器

- [x] 1.1 实现 `radar.schedule.plan.v1` 纯函数（pipeline 墙钟时刻、session 只读项、market 标记）；owner=radar；scope=`src/schedule-plan.ts`；依赖=无；lane=plan；验收=时刻与现网 08:10/08:30/08:42/08:55/08:59 一致，collect 标 wall_clock；验证=`bun test test/unit/schedule-backends.test.ts`；预期=计划快照稳定；失败复查=对照 `config.schedule` 与 canary runbook。
- [x] 1.2 实现 launchd plist 与 Windows Task XML 生成器，CLI `--print` 不写盘；owner=radar；scope=`src/schedule-launchd.ts` `src/schedule-windows.ts`；依赖=1.1；lane=backends；验收=无 cookie/token、日历时刻正确、StartWhenAvailable/IgnoreNew 存在；验证=同上；预期=纯文本快照；失败复查=路径转义与多时刻 trigger。
- [x] 1.3 保持 systemd `buildScheduleUnits` 文本兼容；owner=radar；scope=`src/schedule.ts`；依赖=1.1；lane=compat；验收=既有 `schedule-health` / `market-schedule` 单元键与 flock 行不变；验证=`bun test test/unit/schedule-health.test.ts test/unit/market-schedule.test.ts`；预期=全绿；失败复查=禁止为了新后端改旧字符串。

## 2. CLI 与 doctor

- [x] 2.1 `radar schedule show|install --backend auto|systemd|launchd|windows` 与 `session-plan --runtime grok|claude|both`；owner=radar；scope=`src/cli.ts`；依赖=1.2；lane=cli；验收=Linux auto=systemd 且默认 install 仍写 user 目录；`--print` 不启用；session-plan 不联网、不含 collect；验证=`bun test test/unit/schedule-backends.test.ts` + 进程内 CLI；预期=非法 backend 稳定错误码；失败复查=help/usage 英文。
- [x] 2.2 doctor 按平台探测单元；无 OS 管理器时 next 为 session-plan；owner=radar；scope=`src/diagnostics.ts`；依赖=2.1；lane=doctor；验收=本容器不报 already scheduled；验证=`bun run src/cli.ts doctor --json`；预期=`schedule` 非 ok 且 actions 含真实命令；失败复查=缺 systemctl/launchctl/schtasks 不崩溃。

## 3. 文档与验证

- [x] 3.1 写 `docs/runtime/schedule.md` 并更新 README / docs 索引 / canary runbook；owner=radar；scope=`docs/`；依赖=2.1；lane=docs；验收=给出 macOS/Windows 启用命令与 Claude/Grok 示例，明确 session≠墙钟；验证=人工对照真实命令；预期=无 agent wrapper、无凭据示例；失败复查=语言：文档中文、CLI 英文。
- [x] 3.2 typecheck + 聚焦测试；owner=radar；scope=测试；依赖=1.3、2.2、3.1；lane=verify；验收=typecheck 0、相关 bun test 0；验证=`bun run typecheck` 与上述 test；预期=退出 0；失败复查=先归因脏工作树再改。
