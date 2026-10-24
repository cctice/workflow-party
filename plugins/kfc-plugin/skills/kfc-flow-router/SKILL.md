---
name: kfc-flow-router
description: KFC Personal Plugin 的内部路由实现，负责阶段定位、worker 注册和 workflow 产物状态。
---

# kfc-flow-router

仅由 `kfc` 入口调用。状态写入工作目录 `.kfc/`，用户级动态注册表写入 `KFC_CONFIG_HOME` 或 `~/.config/kfc-plugin/`。路由器不发送网络通知、不读取公司配置、不自动安装依赖。

工作流阶段为 requirement、solution-outline、detailed-design、task-breakdown、development-execution、test-and-selftest、acceptance-guide、acceptance-feedback。每次继续后保持活动 session，skill 产出可追踪文件后才完成该步骤。

包级固定 worker 的移除必须通过 `scripts/package-workers.js` 的 preview → `--plan` → `--apply` 流程，并同时更新 stage steps、worker catalog 和内置注册表。
