# KS CLI 安装说明

本 skill 只通过系统级 `ks` CLI 操作 KS 状态。不要直接读写 `~/.ks`。

## Codex Plugin 发布物

Codex plugin 内的 tarball 路径为：

```text
<plugin-root>/resources/kaleidosphere-<version>.tgz
```

当 `ks --version` 不可用，或其版本与当前 plugin tarball 不一致时，先交由
`runtime-helper` 处理；在确认 tarball 路径后执行：

```bash
npm install --global <plugin-root>/resources/kaleidosphere-<version>.tgz
ks --version
```

Windows 也使用相同的 npm 安装语义；如果当前 shell 无法找到 `ks`，先确认 npm
global bin 目录已加入当前 shell 的 `PATH`，再重试。不能通过手工修改 KS 注册表
替代安装。
