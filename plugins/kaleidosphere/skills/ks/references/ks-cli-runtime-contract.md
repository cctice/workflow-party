# KS CLI 边界说明

KS CLI 是供 Agent 进行精确状态读写和校验的工具层，不接收自然语言，也不承担意图分类。

`ks` 统一入口默认不调用 CLI。只有项目身份已成为已命中专项的必要输入时，入口才可进行一次最小定位；其余 CLI 使用、运行时可用性检查、随包 runtime 获取和复检，均由已命中的专项 skill 按自己的 runtime contract 处理。

这类专项 runtime bootstrap 必须先调用 `runtime-helper` 随附的
`scripts/ensure-runtime.js --json`。检查器比对当前 plugin tarball 和全局 `ks` 的版本，
不一致时仅从当前 plugin 随附 tarball 安装并复检。它只补足专项运行条件，不代表 KS 已支持
完整的安装、卸载、doctor 或 plugin repair。

任何入口或专项都不得绕过 CLI 直接读写 `$KS_HOME` 或 `~/.ks`。
