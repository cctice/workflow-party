# KS CLI 安装说明

本 skill 只通过系统级 `ks` CLI 操作 KS 状态。不要直接读写 `~/.ks`。

## Codex Plugin 发布物

Codex plugin 内的 tarball 路径为：

```text
<plugin-root>/resources/kaleidosphere-<version>.tgz
```

执行任何 `ks` 命令前，先交由 `runtime-helper` 执行当前 plugin 随附的检查器：

```bash
node <plugin-root>/skills/runtime-helper/scripts/ensure-runtime.js --json
```

检查器会运行 `ks --version`；仅当版本与当前 plugin 的
`kaleidosphere-<version>.tgz` 不一致时，才执行
`npm install --global <plugin-root>/resources/kaleidosphere-<version>.tgz` 并复检。Windows
下当前 shell 找不到 `ks` 时，先确认 npm global bin 已在 `PATH`。不能通过手工修改 KS
注册表替代安装。
