---
name: version-manager
description: 管理 KaleidoSphere 受管项目的可选版本规则、版本一致性与受控版本变更。适用于询问是否启用 KS 版本管理、查看版本状态、校验版本、规划或应用用户确认的版本调整。
---

# Version Manager

此能力是 KaleidoSphere 的可选项目能力，不是每个项目的强制要求。它通过系统级
`ks` CLI 管理版本状态；不得直接读写 `~/.ks`，也不得绕过 CLI 自行编辑
`ks-context/versioning.yaml`。

## CLI Runtime Contract

执行任何版本操作前，必须遵守 [KS CLI Runtime Contract](references/ks-cli-runtime-contract.md)。
命令可用后，先运行 `ks version status --project <project-id> --json`，再按返回的
`state` 工作：

- `managed`：已有 KS 版本规则，可继续检查、规划或应用。
- `unmanaged`：用户已明确选择不由 KS 管理版本。告知用户，不重复询问或自行创建规则。
- `needs_user_decision`：尚未决定。必须先询问用户，不能猜测项目版本规则。

## 交互原则

- 首次询问只给出低焦虑推荐：是否由 KS 管理该项目版本？推荐项目及主要构件共用一个版本号。
- 用户接受推荐时，使用统一版本模型：一处真值，所有声明的同步目标保持一致。
- 只有用户明确提出构件独立发布、独立节奏或不同版本号时，才提供高级的多构件模型。
- 用户可使用 SemVer、四段版本或其他项目认可的格式；不强制单一格式。
- 用户明确不启用时，调用 CLI 记录该项目为 `unmanaged`，不创建版本规则文件，也不注入规则入口。
- `status`、`check`、`plan` 是只读动作；任何写入、规则注入或版本变更必须在展示计划后取得明确确认。

## 版本规则与项目入口

启用后，CLI 在开发现场外层维护唯一规则文件：

```text
<project>/ks-context/versioning.yaml
```

该文件定义本项目的版本模型、真值位置、构件和同步目标。它可以表达：

- 项目和 CLI/plugin 等构件共用同一版本；
- 各构件独立维护版本；
- 只管理现有构件文件（例如 `<project-name>/package.json`）中的版本字段。

启用或更新规则时，CLI 应以原子标记块向项目**已有**的 `AGENTS.md`、`CLAUDE.md`、
`GEMINI.md` 注入版本规则入口。不存在的规则文件不应被擅自创建。规则入口缺失、
版本规则不存在且 registry 也未声明 `unmanaged` 时，返回 `needs_user_decision`，由 AI
询问用户后再配置。

## 工作步骤

1. 用 `ks project resolve --path <当前路径> --json` 或 `ks project inspect --id <id> --json`
   确认项目身份；对受管开发现场先运行 `ks project check --id <id> --json`。
2. 运行 `ks version status --project <id> --json`，按状态执行本 skill 的对应分支。
3. 对 `needs_user_decision`，优先推荐统一版本；不要一开始罗列多构件、字段路径和版本格式。
4. 由 CLI 生成配置或变更计划，向用户展示版本真值、受影响构件、同步目标、规则入口文件
   和任何不一致项。
5. 只有用户确认计划后，调用 CLI 的 apply 动作。
6. 完成后运行 `ks version check --project <id> --json`，报告一致性、当前版本和未同步项。

## 边界

- `project-distribution-manager` 只负责项目身份、工作空间和开发现场；它不承担版本模型。
- 本 skill 不假设所有项目都有 `package.json`，也不猜测哪个 manifest 是版本真值。
- 版本管理不替代发布流程；它只维护和验证用户已声明的版本规则。
- 非受管项目、未确认 adoption 的项目和 `unmanaged` 目录不得被本 skill 自动配置。
