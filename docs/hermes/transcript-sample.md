# radar-personal-brief 脱敏 dry-run transcript（4.1 验证样例）

来源：fixture 驱动的 MCP reader 会话（test/integration/mcp-e2e.test.ts 真实子进程
输出），无任何私人创作内容、凭据或原始平台 payload。真实 canary 的每日
transcript 记录方法见 canary-runbook.md。

## 会话 1：ready Edition

```text
user: 今天的短剧机会简报
skill: (reads radar://capabilities) mcp_stdio_lanes=ready; remote/a2a=unavailable — 按边界只读本地。
skill: (reads radar://sources/status) last-collection=degraded, douyin-cookie=blocked → 今日指标偏下界，简报中已标注。
skill: (reads radar://editions/latest)
skill: Edition edition-2026-08-30-ab12cd34 (ready), profile profile-main rev 2:
       1. revenge|identity_reversal  market 66 / fit 78 / conf 53 — reasons: topic_match, hook_match, asset_reuse, cross_platform_signal
          证据偏弱（conf<60），建议深看 radar://opportunities/<ref> 后再决定
       2. sweet_romance|identity_reversal market 40 / fit 71 / conf 62
       建议：radar feedback add --opportunity <ref> --kind saved|dismissed|...
user: 第一个不错，保存
skill: (curator, 经用户确认) radar.execute feedback_add {opportunity_ref, kind:"saved"}
       → receipt id=1, duplicate=false
skill: 已保存；这只影响明天的 Edition，今天的历史条目不变。
```

## 会话 2：absent Edition（真实原因 + 命令，不自行采集）

```text
skill: (reads radar://editions/latest) → {"status":"absent","message":"no edition yet; run 'radar edition build' or 'radar run'"}
skill: 今天还没有 Edition。原因：尚无生成记录（不是数据一定缺失）。请运行：
       radar run        # collect -> score -> cluster -> card + edition
       我不会替你触发采集（collect 属 operator lane 且有外部平台副作用）。
```

## 会话 3：empty Edition（诚实空榜）

```text
skill: (reads radar://editions/latest) status=empty, limitations=[
         "6 candidates below admission thresholds (min_fit=65, min_conf=60)",
         "2 candidates hard-filtered by blocked topics"]
skill: 今日空榜是阈值与硬过滤的结果，不是故障。选项：
       radar profile set --minimum-fit 55        # 放宽准入
       radar profile set --minimum-confidence 55
       或保持高精度，等 Layer 1 后端补证（doctor: xhs-backend blocked）。
```

## 边界核查（每会话）

- [x] 未调用 collect/daily_run（审计账本无对应 success 行）
- [x] Profile 修改仅以 CLI 建议形式给出
- [x] 引用均带 ref（edition/opportunity/profile revision/evidence digest）
- [x] blocked/unavailable 能力只引用 radar://capabilities 原文，未伪造 ready
