# 通过 CLI 管理立项决策与实验

本地软件已支持决策包、证据、候选、基线、实验锁定、结果更正和回顾。它不联网采集、不生成内容、不招募受众；手动录入的数据始终标为人工报告。原有研究文档中的推荐仍未经过真实受众验证。

从 Radar 子项目目录运行 `bun run src/cli.ts decision help` 查看完整参数。安装当前版本 CLI 后也可使用 `radar decision help`。所有命令支持默认英文摘要、`--json`、`--agent`、`--explain`、`--events`，共用同一结果投影。

## 隔离环境的完整 fixture 演练

以下命令需要 Bun 与 jq，创建独立临时数据库。结果明确为 fixture，不会计为真实受众支持或触发两轮失败门。命令生成全部结构化状态，不需要手写 JSON 文件。

```bash
export RADAR_HOME="$(mktemp -d)"
export RADAR_DB_PATH="$RADAR_HOME/radar.db"
export RADAR_CONFIG_PATH="$RADAR_HOME/config.json"

PACK_REF=$(bun run src/cli.ts decision create \
  --title "Animation pilot demo" --objective "Compare two original directions" \
  --topic fantasy --key demo-create --json | jq -r '.data.pack.ref')

bun run src/cli.ts decision evidence add \
  --pack "$PACK_REF" --revision 1 --key demo-evidence \
  --evidence source --kind supply --note "Synthetic reference for CLI verification" \
  --observed-at 2026-01-01T00:00:00Z --url 'https://example.com/reference' --json

bun run src/cli.ts decision baseline set \
  --pack "$PACK_REF" --revision 2 --key demo-baseline \
  --status missing --note "No original independent candidate" --json

bun run src/cli.ts decision candidate add \
  --pack "$PACK_REF" --revision 3 --key demo-treatment \
  --candidate treatment --name "Active-choice fantasy" --market US --locale en \
  --audience "Adult animation viewers" --hypothesis "Explicit choices improve continuation" \
  --rationale "A hypothesis requiring observation" --risk "Lower emotional tension" \
  --falsifier "No continuation gain with comparable quality" \
  --cost-note "Quote unavailable" --evidence source --json

bun run src/cli.ts decision candidate add \
  --pack "$PACK_REF" --revision 4 --key demo-control \
  --candidate control --name "Conventional fantasy" --market US --locale en \
  --audience "Adult animation viewers" --hypothesis "Familiar beats retain viewers" \
  --rationale "Comparable alternative, not an independent method baseline" \
  --risk "Repeated tropes" --falsifier "Lower continuation despite equal quality" \
  --cost-note "Same production scope" --evidence source --json

EXPERIMENT_JSON=$(bun run src/cli.ts decision experiment lock \
  --pack "$PACK_REF" --revision 5 --key demo-lock \
  --candidate treatment --control control --kind hypothesis \
  --budget-note "Fixture only, no spend" --recruitment-note "No real participants" \
  --protocol-note "Offline command verification" --json)
EXPERIMENT_REF=$(printf '%s' "$EXPERIMENT_JSON" | jq -r '.data.experiment.ref')
LOCKED_AT=$(printf '%s' "$EXPERIMENT_JSON" | jq -r '.data.experiment.locked_at')

bun run src/cli.ts decision result record \
  --experiment "$EXPERIMENT_REF" --revision 0 --key demo-result \
  --origin fixture --measurement observed --quality comparable \
  --source-ref synthetic-demo --started-at "$LOCKED_AT" --finished-at "$LOCKED_AT" \
  --treatment-assigned 32 --treatment-continued 22 --treatment-completed 24 --treatment-failures 0 \
  --control-assigned 32 --control-continued 16 --control-completed 24 --control-failures 0 --json

bun run src/cli.ts decision report --pack "$PACK_REF" --json
bun run src/cli.ts decision show --pack "$PACK_REF" --revision 1 --json
```

预期：最终报告的该轮为 `inconclusive`，原因包含 `fixture_not_audience_evidence`；修订 1 仍然没有候选。演练中零时长观察仅演示 fixture 录入，不能用来证明实际观看。

演练变量仅影响当前 shell。进入真实使用前退出该 shell，或取消这些测试覆盖变量后检查目标配置；不要把 fixture 库直接当作真实研究库。

## 真实使用规则

- 有 active Profile 时，新包绑定该 Profile，切换到其他 Profile 后不可见。没有 Profile 时创建的包为本地共享研究，后续创建 Profile 不会使其失联；共享包也受当前禁区约束。需要隔离时先创建／激活 Profile，再建包。
- 每次包写入都要求当前 `--revision` 和唯一 `--key`。先 show，再写入；同键同参重放返回原修订，同键异参拒绝。证据或候选有新理解时用新 ref 追加，旧内容保留。
- URL 只是人工来源引用，必须是没有凭据、签名参数或片段的 HTTPS 地址。条目的 demand 标签是操作者分类，不是系统验证。
- 引用已有市场证据时，用 `--signal`、`--signal-revision`、`--market-evidence` 替代 `--url`，并提供原观测时间。引用必须属于该信号修订且当前可读；目录内容不得变成需求证据，fixture 来源也不能作为独立基线。
- 基线可以明确 missing。independent 要有先前录入的非 fixture 证据，并在建立任何候选之前声明；这是人工声明，系统不认证其独立性。基线一经设置不能重写。方法对照的 control 必须引用该基线证据，缺失基线的研究用新包重新建立正式方法对照。
- 锁定要求两个不同候选，市场、语言和受众完全一致，市场必须明确；不把不同国家样本作 A/B。阈值默认为每组 32 人、提升 15 个百分点、完成率最多降低 10 个百分点、技术故障不超过 10%，可在锁定时显式调整。
- `registration_scope=local` 只说明本机保存了冻结条件。它不是外部预注册、招募许可、费用批准或第三方防篡改证书。修改包不改变已锁定实验，旧实验可以完整回查。
- 真实结果使用 manual，并明确 observed／intent、质量是否可比、来源回执引用和真实时间范围。manual 仍是人工报告，不是自动认证的观看数据；不能把本演练改成 manual 冒充完成。
- 首次结果用修订 0；更正用当前结果修订和 `--reason`，保留旧修订与 origin。继续观看的定义是主动选择第二集并实际看至少 15 秒，完成率要求实际看过首集 90%。计数均以 assigned 为分母，不因退出删人。
- fixture、意愿调查、样本不足、质量不可比或故障过高只能得出 inconclusive。有效观测超过冻结门槛也只得出 directional_support，不能称显著或预测爆款。
- 同协议连续两轮有效不达标，或同协议两轮人工结果均无法判断，会要求暂停。fixture 不计入暂停，也不会清除真实失败序列；协议改变、方法／假设切换不混算。`decision resume` 要求当前包修订、命令键和复查原因，不清除历史。

`decision experiment show --experiment <ref>` 返回冻结快照；`decision result show --experiment <ref> --revision <n>` 回查旧结果。更正结果后 report 按最新结果修订重算，并显示采用的修订号。显式 resume 开启新的复盘窗口，已确认的旧窗口不自动重开。

## 已实现与仍然待做

已实现的是记录和回顾能力，真实访谈、独立研究对照、母语审读、作品制作、招募与观看数据仍需实际执行。预算／招募说明是记录，不是采购或联系授权。没有新增 `used` 含义，没有修改 Edition 排序，也没有把决策包自动送入 Auctra／Scaena。

当前上限为每包 64 条证据、30 个候选、200 个实验。列举返回最多 100 个可读包，并标明是否截断。新表不加入 PG 归档 allowlist，因此现有 `market sync --to pg` 不归档本决策域。回退旧版本时保留新增表，恢复新版本后继续读取，不删除研究数据。

## 软件验证

```bash
bun test test/unit/decision-rules.test.ts
bun run scripts/integration-test-run.ts -- bun test test/integration/decision-pilot.test.ts --timeout 30000
bun run typecheck
```

聚焦集成包含完整 CLI 进程闭环、数据库历史与结果更正、内容／Profile 隔离、基线和跨市场拒绝、两轮暂停与恢复。失败也保留在 `temp/integration-test-runs/`。最终收口脚本在 active OpenSpec 中运行完整测试并生成任务状态；归档后不修改历史任务。

## 从候选到小样实验工作包

新增能力归 Radar；Auctra 做故事开发，Scaena 做小样，DSH 做交互。本地导出是 `prepared_not_accepted`，不是生产接单、招募或播放回执。用户原始基线仍为 missing，不能通过补写材料证明 Radar 优于基础方法。

先使用现有决策包引用查看缺口：

```bash
radar decision prepare --pack "$PACK_REF" --json
```

准备检查分别呈现候选、供给/需求/反证数量、待复核的可信度、未评估的市场吸引力和成本原话。缺少需求资料不会变成“没有机会”的分数；即使缺口为空，也不是立项批准。样本规模、费用、渠道可得性需要调查后确定。

为处理组和对照组各准备两集本地文件，通过 CLI 登记；以下命令中的变量需要替换为实际决策包修订和文件路径：

```bash
radar decision sample add --pack "$PACK_REF" --revision "$PACK_REVISION" --key sample-a1-v1 \
  --sample sample-a1-v1 --candidate "$CANDIDATE_REF" --artifact clip-a1 --version v1 \
  --owner scaena --episode 1 --duration-seconds 60 --locale en --format animation \
  --file "$SAMPLE_FILE" --json
```

每次登记产生新 pack revision，下次使用返回的新修订。文件必须是 1 字节至 512 MiB 的普通文件，最终路径不能是符号链接。Radar 流式计算 SHA-256，不存文件内容或本机路径；语言、时长、格式和质量仍由操作者声明，不进行媒体检测。同一 owner/artifact/version 的内容改变必须使用新版本和新 sample ref。

将相同方式登记的四份 sample 引用锁入新实验：

```bash
radar decision experiment lock --pack "$PACK_REF" --revision "$PACK_REVISION" --key bound-round-1 \
  --candidate "$CANDIDATE_REF" --control "$CONTROL_REF" --kind hypothesis \
  --budget-note "$BUDGET_NOTE" --recruitment-note "$RECRUITMENT_NOTE" --protocol-note "$PROTOCOL_CONDITIONS" \
  --sample-per-arm "$SAMPLE_PER_ARM" --min-lift-pp "$MIN_LIFT_PP" \
  --max-completion-drop-pp "$MAX_COMPLETION_DROP_PP" --max-failure-percent "$MAX_FAILURE_PERCENT" \
  --sample "$TREATMENT_EP1_REF" --sample "$TREATMENT_EP2_REF" \
  --sample "$CONTROL_EP1_REF" --sample "$CONTROL_EP2_REF" \
  --allocation randomized --recruitment-channel "$RECRUITMENT_CHANNEL_REF" --quality-standard "$QUALITY_STANDARD" --json
```

两组须是相同明确市场、受众、语言、格式，对应集时长一致。每组必须恰好第 1、2 集；完全相同的两组内容不构成差异测试。`protocol_note` 保存实质条件，`budget_note` 和 `recruitment_note` 保存运营说明。新材料协议比较忽略后两项备注，但包含渠道、分配方法、质量标准和其余实质条件；改变真实招募条件时应修改渠道或 protocol_note，不能只改备注。材料身份绑定当轮，不因新一轮换剪辑就自动破坏方法可比性。

`experiment lock/show` 的 JSON 返回 `materials.digest`；给结果录入命令额外提供 `--materials-digest "$MATERIALS_DIGEST"`。每次更正同样需要冻结摘要。缺失或不匹配会被拒绝；摘要不证明受众实际看过这些材料。未绑定材料的旧实验继续使用原有结果命令与协议解释，不补写旧快照，也不能伪装成材料已绑定的工作包。

导出是本地文件操作，必须选择尚不存在的文件：

```bash
radar decision workpack show --experiment "$EXPERIMENT_REF" --json
radar decision workpack export --experiment "$EXPERIMENT_REF" --output "$NEW_EXPORT_FILE" --json
```

内容包含冻结候选、证据、实验条件、四份材料引用及摘要；不上传素材，不调用下游生产。文件权限为 0600；重复导出到不同新路径内容一致。实际交接前由消费者确认版本和引用可读性，不能把导出结果当作 Auctra/Scaena 已接受的合同。

尚无结果且无法执行的实验可以取消：

```bash
radar decision experiment cancel --experiment "$EXPERIMENT_REF" --key cancel-round-1 --reason 'Recruitment unavailable before observation' --json
radar decision report --pack "$PACK_REF" --json
```

取消理由和时间不可变；同 key 同输入可重放，不写虚假零结果。已有结果必须用有理由的结果更正，不能取消。报告读取顺序先看 `lifecycle`：`cancelled` 不再待执行、不能录结果或导出；保留旧 `verdict=pending` 仅表示没有结果，不能单独据此判断可执行。取消不计入、也不清除真实失败序列。已导出的离线包不会自动撤回，执行前应使用 `experiment show` 检查 `facts.cancelled`。误取消后锁定新实验，历史保留。

本轮验证全部使用隔离夹具。后续业务完成标准仍是调查渠道/成本并锁定条件、真实小样测试、回顾支持或推翻的判断；软件闭环不等于市场价值已验证，来源资格及十四天验证继续适用。
