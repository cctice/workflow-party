# Runtime Tarball Contract

`runtime-helper` 只能从当前激活 KaleidoSphere plugin 的 `resources/` 目录读取
`kaleidosphere-<version>.tgz`。所有版本比对、`ks --version` 调用、安装和复检都必须由随包
检查器完成：

```bash
node <plugin-root>/skills/runtime-helper/scripts/ensure-runtime.js --json
```

检查器只会在 `ks --version` 与 tarball 版本不一致时执行
`npm install --global <plugin-root>/resources/kaleidosphere-<version>.tgz`，并要求复检结果与
文件名中的版本完全一致。不得直接读写 `~/.ks` 或 `$KS_HOME`，也不得从未知 URL、其他项目
目录或开发工作树安装包。
