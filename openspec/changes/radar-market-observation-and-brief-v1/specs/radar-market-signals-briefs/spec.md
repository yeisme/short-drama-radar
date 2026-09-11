## ADDED Requirements

### Requirement: 显式更正后的恢复必须经过新证据审查
自动分析 MUST NOT 覆盖显式撤回或证据不足更正。owner 恢复操作 MUST 绑定当前更正 revision、同源同作同市场同 origin 的较新观测、理由及非未来审查时间；指标恢复必须满足原比较合同。恢复 MUST 追加修订并保留历史，相同输入重放返回原修订，陈旧版本拒绝。

#### Scenario: 新指标不能自动撤销人工更正
- **WHEN** 已撤回信号出现新的指标观测，自动分析再次运行
- **THEN** 保存观测并返回 correction_review_required，不恢复有效判断；只有通过明确证据审查才能追加 active 修订

#### Scenario: 恢复后仍能回看撤回历史
- **WHEN** owner 使用有效新观测恢复 revision 2 的更正
- **THEN** revision 3 可进入未读，revision 1 与 revision 2 保持原值，重放同一审查不新增 revision

### Requirement: 定量变化必须建立在可比观测上
系统 MUST 以来源修订、地区、采样范围、指标定义、窗口规则和分类版本构成 comparison_key；只有两个可比观测才可确认涨跌。现有 daily score MUST NOT 用作跨日涨跌。

#### Scenario: 新增采样源
- **WHEN** 今日新增一个来源使某题材条目增加
- **THEN** 新来源单独建立 baseline，不能把合并计数变化标成市场升温

#### Scenario: 统计口径漂移或零分母
- **WHEN** 指标定义、采样窗口改变，计数重置、数据缺失或基期为零
- **THEN** 返回 metric_incomparable 或明确不可计算的事实，不补零、不计算虚假百分比

### Requirement: 每个信号必须说明命题类型和证据等级
信号 MUST 包含 claim_kind、assertion_level、comparison_refs、evidence_refs、limitations 和规则版本，遵循 design 的七类命题证据门。confirmed 表示命题已核验，MUST NOT 被表达为商业成功概率。

#### Scenario: 首页推荐换位
- **WHEN** 同一页面的推荐作品改变
- **THEN** 可生成 listing/placement 变化，不能声称用户热度上升

#### Scenario: 首次看到作品
- **WHEN** 系统第一次采到一部既有作品
- **THEN** 表达为 newly_observed，不表达为今日全网上新

#### Scenario: 小样本题材变化
- **WHEN** 固定样本任一比较窗少于 10 个独立作品，或采样框不完整
- **THEN** 不确认题材占比趋势，仅保留带限制的 observed 信号

### Requirement: 信号必须保留修订和更正历史
signal_ref SHALL 持续标识同一命题主体，revision 单调递增。更正、撤回和身份映射变化 MUST 创建新修订，不改写旧版次；后续缺失必须 inconclusive，不能推导 cooled。

#### Scenario: 后续推翻判断
- **WHEN** 新证据证明先前合并了两个不同作品
- **THEN** 新修订引用原修订和反证，受影响简报通过更正连接，原版次仍可审查

#### Scenario: 后续来源断采
- **WHEN** 没有可比后续观测
- **THEN** 标为 inconclusive，不计入趋势下降或判断失败

### Requirement: 市场简报必须独立且不可变
系统 MUST 提供 radar.market_brief.v1，与个人 Edition 分开；原子保存输入指纹、规则版本、时间窗口、coverage、信号修订及 digest。相同输入复用结果，不要求创建创作 Profile。

#### Scenario: 无 Profile 首次读取
- **WHEN** 无 active Profile 但已有已完成市场简报
- **THEN** 用户可读市场简报，不因 personal_fit 缺失而空榜

#### Scenario: 冻结过程中失败
- **WHEN** brief 与 entries 的写入中断
- **THEN** 回滚整个新 brief，最近成功版次可读并明确日期，不留下半份日报

### Requirement: 快读必须有界且不凑数
主摘要 SHALL 最多 5 条、待观察最多 2 条，采用 design 的确定顺序和题材上限；更正超额必须可发现完整列表。无重大变化、缺数据和生成失败必须分别表达。

#### Scenario: 只有一条有效变化
- **WHEN** 本窗只产生一条满足证据门的变化
- **THEN** 只展示这一条，不用旧闻或低置信候选补满主摘要

#### Scenario: 更正多于首屏上限
- **WHEN** 本窗出现六条更正
- **THEN** 显示更正总数与完整列表入口，不能因上限静默遗漏第六条

#### Scenario: 国内外都有合格变化
- **WHEN** 国内和海外均有通过证据门的新变化且更正未占满首屏
- **THEN** 至少各保留一条，再按确定顺序填充，不因同一来源批量更新挤掉另一市场

### Requirement: 日报必须显式定义时间和迟到语义
系统 MUST 保存 IANA timezone、window_start/end、observed_at 和 publication cutoff；默认 UTC 当地 09:00。迟到数据进入后续版次并保留原观测时间，不倒写历史。

#### Scenario: 跨时区或夏令时切换
- **WHEN** 用户更改时区或当地时间跨越夏令时
- **THEN** 以真实时间边界构建连续且不重叠窗口，标明时区/策略修订，不能假设每天固定 24 小时

#### Scenario: 截止后来源返回
- **WHEN** 来源结果迟于本次截止点
- **THEN** 已冻结日报保持不变，该观测进入后续版次并明确迟到

### Requirement: 跨市场对照必须保留不同口径
系统 MUST 以题材或 verified work mapping 对照各地区证据，保留原名、窗口、指标定义与未知地区；不能把先后观测当作传播因果。

#### Scenario: 不同地区不同指标
- **WHEN** 一侧是榜单位置而另一侧是互动数
- **THEN** 分栏呈现各自指标，不计算统一全球热度分或共用数值轴

### Requirement: 周度回顾必须可追溯且诚实处理未知
周度回顾 SHALL 默认周一当地 09:10 冻结上一完整周，引用当时 signal revision 和后续证据，输出 sustained/cooled/retracted/inconclusive，不伪称预测准确率。

#### Scenario: 只有原始判断没有后续
- **WHEN** 某信号没有有效后续证据
- **THEN** 记为 inconclusive，计入待验证数量，不算成功或失败
