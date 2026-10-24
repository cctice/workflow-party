---
name: kfc-worker-security-review
description: KFC skill。审查当前改动的安全边界，记录可验证风险、修复建议和未覆盖项。
---

# kfc-worker-security-review

围绕实际改动检查输入验证、权限、秘密信息、外部请求、命令执行及路径边界。区分已确认漏洞和需要验证的疑点，给出触发条件、影响和依据。默认不调用真实外部服务，不读取无关凭据，不执行破坏性验证；测试或扫描缺失须如实记录。

保持当前活动 step session，直到产物可记录。输出实际产物路径、用途、验证结果或限制，以及 `produced_by: kfc-worker-security-review`。
