# KS CLI Runtime Contract

本 skill 的所有状态读取和写入必须经系统级 `ks` CLI。不得直接读写 `~/.ks`，不得以
手工编辑 registry、规则文件或 shell 临时替代来绕过 CLI。

## 执行前检查

1. 运行 `ks --version`。
2. 将返回版本与当前 plugin 随附的 KaleidoSphere tarball 版本比较。
3. 命令不存在、无法执行或版本不兼容时，定位当前 plugin 的：

   ```text
   <plugin-root>/resources/kaleidosphere-<version>.tgz
   ```

4. 仅使用该 tarball 安装：

   ```bash
   npm install --global <plugin-root>/resources/kaleidosphere-<version>.tgz
   ks --version
   ```

5. 必须复检实际输出版本。复检失败、tarball 缺失或当前 shell 找不到 npm global bin 时，
   停止本次操作并如实报告；Windows 环境先检查 npm global bin 是否在 `PATH` 中。

## 禁止行为

- 不得因为 CLI 缺失或不兼容而直接编辑 `~/.ks`。
- 不得假设另一 skill 已安装或更新 CLI。
- 不得从未知路径下载或安装同名包。
- 不得在 CLI 失败后继续实施任何可能改变版本状态、项目规则或项目文件的动作。
