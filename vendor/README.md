# judgment SDK 本地包快照

来源：Aigora `sdk/judgment/typescript`，版本 0.1.0，本次 review2 构建；Apache-2.0 许可证随包提供。由 `bun pm pack` 生成，package.json 与 bun.lock 通过 `bun add` 管理；不手工编辑包内容。包中包含原始 TypeScript、测试与许可证，不含用户配置或密钥。

重建命令（从 SDK 目录运行）：

```bash
bun pm pack --filename /workspaces/yeisme-agent/cli/short-drama-radar/vendor/yeisme-judgment-sdk-0.1.0-review2.tgz
```

后续更新改用新文件名，避免包管理器缓存旧同名 tarball；然后在 Radar 使用 `bun add ./vendor/<新包名>.tgz`。本仓安装不依赖 sibling 路径，也不声称包已公开发布。
