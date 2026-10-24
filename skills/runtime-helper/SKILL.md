---
name: runtime-helper
description: 确保当前 KaleidoSphere plugin 随附的 ks CLI 与系统全局 ks 命令版本一致。适用于已命中 KS 专项且需要调用 CLI，或 plugin 更新后发现全局 CLI 仍是旧版的场景。
---

# Runtime Helper

此能力只为已命中的 KS 专项准备 CLI runtime，不处理项目身份、注册表、版本规则或项目文件。
它是 plugin 更新与全局 `ks` 安装分离时的受控修复入口。

## CLI Runtime Contract

不得直接读写 `~/.ks`、`$KS_HOME` 或项目文件。只使用当前激活 plugin 中随附的 tarball：

详细约束见 [Runtime Tarball Contract](references/ks-cli-runtime-contract.md)。

```text
<plugin-root>/resources/kaleidosphere-<version>.tgz
```

## 执行步骤

1. 确认当前 plugin 的 `resources/` 中存在且只有一个 `kaleidosphere-<version>.tgz`；从文件名得到期望版本。
2. 运行 `ks --version`。若命令不可用、无法执行，或输出版本与期望版本不同，继续下一步；相同则报告 runtime 已就绪。
3. 仅安装当前 plugin 的 tarball：

   ```bash
   npm install --global <plugin-root>/resources/kaleidosphere-<version>.tgz
   ```

4. 再次运行 `ks --version`。只有输出与 tarball 版本完全一致时，才向原专项返回“runtime 已就绪”。
5. tarball 缺失、npm 安装失败、复检失败或当前 shell 找不到 `ks` 时停止，并如实报告；Windows 先确认 npm global bin 位于 `PATH`。

## 边界

- 不得从网络、开发工作树或未知目录下载同名包。
- 不得假设 marketplace/plugin 更新会自动更新全局 CLI。
- 不得在 runtime 未就绪时继续调用 `ks project`、`ks version` 或其他需要 CLI 的专项命令。
- 这不是完整 self-management：安装、卸载、doctor、plugin repair 与跨 Agent runtime 适配仍需单独能力。
