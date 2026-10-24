---
name: kfc-worker-development-execution
description: KFC skill。按当前任务执行开发，优先用行为测试验证代码改动，并记录实际验证结果。
---

# kfc-worker-development-execution

读取当前任务、相关源码和已有测试。明确对外行为与最小验证入口；对行为变更先写一个会失败的测试，确认原因后做最小实现，再运行该测试。按需重复并在通过后重构。复制、重命名或纯说明修改使用对应结构检查，不机械补实现镜像测试。没有可运行测试环境时说明限制，不能编造通过结果。

保持当前活动 step session，直到产物可记录。输出实际产物路径、用途、验证结果或限制，以及 `produced_by: kfc-worker-development-execution`。
