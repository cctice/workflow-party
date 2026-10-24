# KS CLI Runtime Contract

任何由执行协调 skill 发起的 `ks` CLI 操作，均按以下契约执行：

1. 先运行 `ks --version`，并确认输出与当前 plugin release 所需版本一致。
2. 命令缺失、不可执行或版本不一致时，仅使用当前 plugin 随附的 `resources/kaleidosphere-<version>.tgz` 执行 `npm install --global <plugin-root>/resources/kaleidosphere-<version>.tgz`；不得从网络、开发工作树或未知目录获取包。
3. 安装后再次运行 `ks --version` 精确复检。安装或复检失败时停止当前协调操作。
4. 不得因 CLI 不可用、安装失败或调用失败，直接读写、猜测或恢复 `~/.ks`、`$KS_HOME` 或协调状态。

当前可用的协调接口是 `ks coordination <open|find|resume|archive>` 与
`ks chat-room <open|append|archive|split>`。Skill 只在意图、项目身份和用户确认边界已满足时调用它们；不得自行扩展参数、目录或状态 schema。
