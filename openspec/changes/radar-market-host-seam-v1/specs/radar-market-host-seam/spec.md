## ADDED Requirements

### Requirement: host seam 必须是本地 stdio 单消费者服务
`radar market host-serve` SHALL 以 stdin/stdout 换行分隔 JSON 帧提供服务（schema `radar.market.host.frame.v1`），stderr SHALL 只输出诊断；MUST NOT 监听网络端口、常驻后台或允许多个并发消费者。进程 SHALL 随 stdin 关闭或 shutdown 帧结束而退出。

#### Scenario: 消费者断开
- **WHEN** DSH adapter 关闭 host-serve 的 stdin 或发送 shutdown 帧
- **THEN** 进程在返回 ack 后退出，不留后台进程或端口

#### Scenario: 帧外输出
- **WHEN** 读帧处理过程中发生诊断级事件
- **THEN** stdout 只含帧内容，诊断只走 stderr，帧协议不被破坏

### Requirement: 只读帧必须复用市场服务并保持禁区与诚实状态
读帧 SHALL 经由现有 market 服务函数产出安全投影（与 CLI `--json` data 同源），覆盖 capabilities、reader、latest/指定 brief、signal revision 详情、source coverage gaps、watch list 与 watch changes、catchup 分页、reading list、compare、review index/指定 review、evidence 指定 ref 与 question context；内容禁区 MUST 在每个读出口执行，degraded/empty/source_gap MUST 诚实呈现，未实现资源 MUST 返回具名错误而非空数据。

#### Scenario: 禁区命中
- **WHEN** 请求的 signal revision 含当前 blocked topic 或不可判定分类
- **THEN** 返回 content_blocked 错误帧，不携带被滤内容

#### Scenario: 补看翻页
- **WHEN** catchup 帧携带 owner 游标请求下一页且期间 reader/policy 未变
- **THEN** 返回下一页信号与续游标；末页 next_cursor 为 null，空页不推断“无变化”

#### Scenario: 指定版次缺失
- **WHEN** 请求 signal 指定 revision 而该修订不存在
- **THEN** 返回 signal_not_found，不回退最新修订

### Requirement: dispatch 必须只接受 typed proposal 并幂等对账
dispatch SHALL 只接受 `dsh.radar.intent.v1` kind=proposal，映射 owner 本地 createAssignment；同键同参重放 SHALL 返回原回执；同键异参 SHALL 返回 idempotency_conflict；空榜或不达标 SHALL 返回 do_not_shoot 的 rejected 回执；`lookup-receipt` SHALL 按原键返回 reconciled 回执或 null，MUST NOT 触发二次写入。其他 intent kind 或非法结构 MUST 被具名拒绝且零写入。

#### Scenario: 幂等重放
- **WHEN** 同一 proposal intent 以相同 idempotencyKey 再次 dispatch
- **THEN** 返回与首次一致的回执与 assignmentRef，不新增 assignment

#### Scenario: 空榜提案
- **WHEN** 当前 Edition 无可指派机会时提交 proposal
- **THEN** 返回 outcome=rejected 且 reason 明示 do_not_shoot，不伪造成功

#### Scenario: 非法 intent
- **WHEN** dispatch 收到 schema 不符、kind 非 proposal 或 ref 不安全的 intent
- **THEN** 返回具名错误帧，数据库零写入

### Requirement: 帧错误必须是具名且脱敏的稳定代码
帧错误 SHALL 携带稳定英文 code（复用既有 MarketStoreError 码）与脱敏 message；帧与诊断 MUST NOT 携带原始 HTML、快照 payload、凭据、cookie、token 或文件路径；畸形请求行 MUST 返回 frame_invalid 且不中断帧循环。

#### Scenario: 畸形行
- **WHEN** stdin 收到非 JSON 或缺字段的行
- **THEN** 返回 `id:null` 的 frame_invalid 错误帧，循环继续处理后续帧

#### Scenario: 无效 URI
- **WHEN** 读帧的 URI 含不安全字符段或未知路径
- **THEN** 返回 resource_not_found 或 input_invalid，不执行命令
