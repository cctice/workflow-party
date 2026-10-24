# KS CLI Runtime Contract

任何由执行协调 skill 发起的 `ks` CLI 操作，均按以下契约执行：

1. 先调用当前 plugin 随附的 `runtime-helper` 检查器：

   ```bash
   node <plugin-root>/skills/runtime-helper/scripts/ensure-runtime.js --json
   ```

2. 检查器运行 `ks --version`；仅当版本与当前 plugin 的
   `resources/kaleidosphere-<version>.tgz` 不一致时，才执行
   `npm install --global <plugin-root>/resources/kaleidosphere-<version>.tgz` 并复检。不得从网络、开发工作树或未知目录获取包。
3. 只有 `afterVersion` 与 `expectedVersion` 一致时继续协调操作；否则停止。
4. 不得因 CLI 不可用、安装失败或调用失败，直接读写、猜测或恢复 `~/.ks`、`$KS_HOME` 或协调状态。

当前可用的协调接口是 `ks coordination <open|find|resume|archive>` 与
`ks chat-room <open|append|archive|split>`。Skill 只在意图、项目身份和用户确认边界已满足时调用它们；不得自行扩展参数、目录或状态 schema。
