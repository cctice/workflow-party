# Runtime Tarball Contract

`runtime-helper` 只能从当前激活 KaleidoSphere plugin 的 `resources/` 目录读取
`kaleidosphere-<version>.tgz`。先运行 `ks --version`，版本不一致或命令不可用时，执行：

```bash
npm install --global <plugin-root>/resources/kaleidosphere-<version>.tgz
ks --version
```

复检结果必须与 tarball 文件名中的版本完全一致。不得直接读写 `~/.ks` 或 `$KS_HOME`，也不得
从未知 URL、其他项目目录或开发工作树安装包。
