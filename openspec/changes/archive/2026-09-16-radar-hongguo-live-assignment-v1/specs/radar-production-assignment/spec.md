## ADDED Requirements

### Requirement: assignment 必须绑定不可变 Edition
`radar assignment create` MUST 引用当前 Profile 的指定或最新 Edition，并记录 profile revision、三类分数、why-this、why-not-others、证据限制和 `target_owner=auctra`。Profile head 与 Edition 的 revision 不一致时 MUST `assignment_stale`。下游未提交时 MUST NOT 写 `used`。

#### Scenario: 就绪 Edition
- **WHEN** Edition 为 ready 且指定或默认第一条机会
- **THEN** 创建 `ready` assignment，含 reason codes 与其余条目的 why-not-others

#### Scenario: 空榜
- **WHEN** Edition 为 empty
- **THEN** 创建 `do_not_shoot` assignment，opportunity_ref 为空

### Requirement: assignment 必须幂等
同一 idempotency key（默认 edition+opportunity+profileRevision+brief）MUST 返回原 assignment。同键异参 MUST `idempotency_conflict`。

#### Scenario: 重放
- **WHEN** 相同参数再次 create
- **THEN** reused=true，不新增行

### Requirement: 拒绝必须写反馈且不打开下游
`radar assignment reject --kind too_risky|not_relevant` MUST 将 assignment 标为 rejected；若存在机会则 append 对应反馈。MUST NOT 调用 Auctra。

#### Scenario: 拒绝有机会的任务
- **WHEN** ready assignment 被 too_risky 拒绝
- **THEN** assignment 为 rejected，反馈 kind=too_risky，无 used

### Requirement: 提交 Auctra 成功后才写 used
`radar assignment submit --assignment <ref> --auctra-path <project>` MUST 调用 Auctra `text proposal from-radar`。只有 Auctra 返回 pending_review refs 后 MUST 把 `downstream_status` 标为 submitted，保存不透明 proposal/review/unit refs，并对机会 append `used`。do_not_shoot、rejected 或 Auctra 失败 MUST NOT 写 used。已 submitted 的重放 MUST 返回原回执。

#### Scenario: 首次提交成功
- **WHEN** ready assignment 提交到已有 Auctra 项目
- **THEN** downstream_status=submitted，used 反馈带 opaque project/proposal ref

#### Scenario: Auctra 不可用
- **WHEN** auctra 二进制缺失或命令失败
- **THEN** assignment 保持 not_submitted，无 used

### Requirement: Auctra accept 后才能建 Scaena 项目
`radar assignment produce --assignment <ref> --scaena-path <dir>` MUST 先确认 Auctra proposal 为 `accepted`，再调用 `scaena handoff radar import --confirm`。成功 MUST 把 `downstream_status` 标为 `produced` 并保存不透明 Scaena receipt。pending_review MUST 拒绝。MUST NOT 启动分镜或生成。

#### Scenario: 提案已接受
- **WHEN** submitted assignment 的 Auctra proposal 为 accepted
- **THEN** Scaena 工作区存在，assignment.scaena.receipt_ref 有值

#### Scenario: 仍待审
- **WHEN** Auctra status 仍为 pending_review
- **THEN** 不调用 Scaena 写入，assignment 保持 submitted
