---
name: kfc-worker-development-record
description: KFC skill。记录开发执行结果、改动范围、验证入口和剩余风险，并输出产物路径和作用。
---

# kfc-worker-development-record

记录开发阶段的执行结果。本 skill 不负责编码，也不替代具体开发类 skill。

## 使用场景

- 当前工作流已经进入 development-execution 阶段。
- 用户希望 `/kfc 继续` 能顺滑接到开发阶段，不在流程上断档。
- 需要把已经完成或正在完成的开发工作整理为后续测试、自测和代码审查可消费的记录。

## 工作内容

- 记录本轮开发对应的任务或任务包。
- 记录实际修改范围和关键文件。
- 记录已经执行的验证入口、命令、结果或未验证原因。
- 记录剩余风险、待确认事项和建议进入的下一步。
- 如果用户需要实际编码能力，应改用候选开发 skill 或由当前 agent 按用户授权执行开发。

## 输出格式

输出必须说明：

- 产物路径
- 产物作用
- produced_by: `kfc-worker-development-record`

建议产物包含：

- task_ref
- implementation_summary
- changed_files
- validation_entry
- unverified_items
- remaining_risks
- suggested_next_step
