# Tasks

- [x] 1.1 secret-store 桥（credentialRef→storageState、proxyRef→launch proxy、0600、RADAR_SECRETS_DIR）+ 单测
- [x] 1.2 launchPlaywright 先解析后启动；缺凭据/缺代理显式降级带修复提示 + gate 测试
- [x] 1.3 playwright 硬依赖 + doctor playwright 检查升级（模块+chromium）
- [x] 1.4 probeLayer2 + capabilities 派生（status/reasons/next_action）+ fixture 注记 + CLI 合同断言
- [x] 1.5 配额接线（config→AdapterContext→browser）+ 死配置删除
- [x] 1.6 L2 能力上限显式化（头注释 + 本 change）
- [x] 1.7 specs delta + strict validate + 全量验证
