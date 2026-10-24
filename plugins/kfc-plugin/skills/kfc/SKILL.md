---
name: kfc
description: 个人 KFC 工作流入口。用于按阶段定位开发、测试、复核、验收和交付材料；仅使用本地状态和个人配置。
---

# KFC 个人入口

本 skill 接收 `/kfc ...` 请求，调用包内 `kfc-flow-router/scripts/kfc.js` 完成状态、阶段和产物记录。它只使用个人配置目录 `~/.config/kfc-plugin/`（可由 `KFC_CONFIG_HOME` 覆盖），不读取公司 KFC 注册表。

## 入口命令

```bash
node kfc/scripts/kfc.js current --root <workflow-root>
node kfc/scripts/kfc.js route --root <workflow-root> --material "<材料>"
node kfc/scripts/kfc.js continue --root <workflow-root> [--skill <skill-name>]
node kfc/scripts/kfc.js complete --root <workflow-root> --output-path <path> --purpose "<用途>"
node kfc/scripts/kfc.js steps list --stage <stage>
node kfc/scripts/kfc.js dependencies --check-only
```

执行工作时必须读取路由结果中的 `current_stage`、`active_step_session`、`next_step`、`selected_skill`、`flow_node_check` 和 `next_required_action`。存在活动 session 时继续同一个 skill，直到产物可记录，再调用 `complete`。

## 个人边界

- 不执行入口上报，不发送网络通知，不要求使用人登记。
- 不安装或更新公司 skill 聚合包；缺少可选 skill 时报告位置和选择，不静默联网安装。
- 外部工单、外部质量扫描和公司质量门禁已从个人包固定步骤、worker catalog 与内置注册表移除。
- 个人包级 worker 注销只能通过 `kfc-flow-router/scripts/package-workers.js` 的预览、哈希确认、应用流程完成；不要直接编辑这些注册表。

## 输出

最终结果说明当前阶段、活动 session、产物路径、用途、验证结果和剩余风险。若只是定位或检查，保持只读，不调用 `complete`。
