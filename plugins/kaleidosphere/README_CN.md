# 万花境（KaleidoSphere）

万花境是一个面向人机协同的、插件化的 AI 工作资源协调层。本插件提供 KS 入口、
本地项目资产、全局火花、可选版本管理、可选项目规则沉淀、运行时修复，以及显式复杂
执行协调。

它不会自动扫描项目、启动工作流、拆分任务或执行高风险操作。只有请求确实相关时才
使用 KS；迁移、发布、删除及其他不可逆操作仍需用户确认。

## 随附 Skills

- `ks`：显式 KS 入口和轻量能力路由。
- `project-distribution-manager`：项目、外部 Git 接手计划、开发现场、项目语义定位、`ks-context` 和火花。
- `version-manager`：可选项目版本管理。
- `project-rule-manager`：经用户确认的长期项目规则。
- `execution-coordination`：显式复杂协同与可恢复聊天室状态。
- `runtime-helper`：KS CLI 运行时版本检查和修复。

产品架构、路线图和开发文档以源码仓库为准，未随本插件分发。
