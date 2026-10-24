---
name: kfc-worker-code-review
description: KFC skill。审查当前实现 diff，输出有依据、可操作的代码问题和验证缺口。
---

# kfc-worker-code-review

先检查当前分支、工作树和本轮 diff，再读取相关调用点与测试。只报告可以解释触发条件和影响的缺陷，标注优先级、文件和行号；没有发现时明确说明检查范围与未覆盖项。审查默认只读，用户已授权修复时才修改代码。

保持当前活动 step session，直到产物可记录。输出实际产物路径、用途、验证结果或限制，以及 `produced_by: kfc-worker-code-review`。
