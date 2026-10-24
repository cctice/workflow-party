---
name: project-distribution-manager
description: 管理本地项目工作空间、开发现场、项目身份、路径映射、项目归类和全局火花资产。适用于创建、登记、查找、移动或接手需要持续开发的本地项目，以及定位和记录火花。
---

# Project Distribution Manager

此能力是 KaleidoSphere 的内部能力，也可以被直接调用。它通过 `ks` CLI 管理项目资产和全局火花资产，不直接读写 `$KS_HOME`。本 release 中 `ks` CLI 当前安装目录仍可作为命令入口；项目在开发现场内时，项目本体位于与项目同名的内层目录，局部上下文位于外层 `ks-context/`。

## 体系定位

KaleidoSphere 是面向人机协同的、插件化的 AI 工作资源协调层。它借鉴操作系统在
资源组织、接口抽象和协调方面的架构思想，但不是操作系统、通用运行时、桌面环境或
自治工作流引擎。它的目标是为多 Agent、多项目和本地能力提供可持续的开发现场、
项目资产管理、上下文关联和能力路由。

`project-distribution-manager` 是 KS 当前第一项已实现能力，用于管理本地项目资产；
它不是 KS 的完整定义，也不代表其他规划中能力已经可用。介绍 KS 时，先说明这一
目标，再明确当前可用能力和其他专项能力的实际状态。

## KS CLI 前置条件

执行任何项目资产操作前，先运行 `ks --version`。对已登记项目，在读取、调整、迁入或
继续开发前，先运行 `ks project check --id <project-id> --json`，再根据返回的 `compliant`、
失败项和修复建议决定下一步。若命令不可用或版本不符合当前
plugin 随附版本，读取同目录的 [KS CLI 安装说明](references/ks-cli.md)，使用该
plugin 内随附的 npm tarball 安装后再次检查。安装或复检失败时停止，不得改为直接
读写 `$KS_HOME`。

## 处理原则

- 先询问用户项目要进入哪个空间：`work`、`personal`、`tooling`、`playground` 或 `temporary-proj`。
- 只有需要持续开发、修改或维护的项目才纳入 KaleidoSphere 管理。
- 仅下载、研究、打包或临时查看的材料应由用户决定是否放入 `unmanaged`，不得自行登记为项目。
- 项目本体必须是 Git 仓库。ZIP 或非 Git 材料只有在用户明确要求转换为受管项目后，才能通过 clone 或初始化 Git 进入受管空间。
- 项目移动、重新归类和 adoption 必须由用户显式提出，不能根据路径或内容自行执行。
- 项目路径表达稳定归属，项目注册表的 `tags`、`aliases`、`summary` 和 `lifecycle` 表达可检索语义；不得用路径层级替代业务标签，也不得把这些字段写入项目本体。
- `lifecycle` 仅表示注册表中的 `active`、`paused`、`archived` 状态，不等同于 Git 工作树、交付工作流或发布状态。标签为空是合法状态，不能因此判定项目不合规。
- `<project-name>/` 是项目本体；`ks-context/` 是项目本体之外的局部上下文。不得向项目本体写入 KS 专用文件。
- 全局 `sparks/` 是 KS 管理的火花资产空间，不属于任一项目的 `ks-context/`。用户明确提到火花、灵感备忘录或之前的火花文件时，必须先用 `ks spark list` 或 `ks spark find` 定位，不得猜测或改写项目协作记录。
- 本地项目创建可不提供 Git 身份；CLI 在 `ks-context/project.json` 中记录 `gitIdentity: null`，并使用固定的本地专用提交作者完成内外 Git 初始化，不读取全局 Git 配置。
- 只有配置远程、推送或需要远程身份校验时，才询问用户 Git 姓名和邮箱；两项必须同时显式传入，CLI 才将非敏感身份元数据写入 `ks-context/project.json` 并用于后续本地提交。

## 开发现场

受管项目的标准开发现场如下。内层同名项目目录保留项目本体的 Git 历史与远程；外层 Git
只管理本地的 `ks-context/`、外层说明和忽略规则。

```text
<workspace>/<project-name>-proj/
├── <project-name>/           # 项目本体，必须是 Git 仓库
├── ks-context/              # 项目背景、对接、隐性知识、连接引用、交接等
├── README.md                # 可选
├── .gitignore               # 忽略 <project-name>/
└── .git/                    # 开发现场的本地管理 Git
```

已登记的旧式直连仓库是迁整理输入，不是新的默认布局。只有用户明确要求“迁入开发
现场”或“转换为标准结构”时，才可以调用迁移命令；不得因为它位于受管工作空间内就
自动迁移。

## 当前 CLI 接口

```text
ks init
ks workspace add --id <id> --path <path>
ks workspace list
ks project create --workspace <id> --name <kebab-case-name> [--git-name <name> --git-email <email>]
ks project register --workspace <id> --name <kebab-case-name> --path <path> --layout direct
ks project update --id <project-id> [--name <kebab-case-name>] [--workspace <id>] [--path <existing-git-repository>]
ks project tag <add|remove> --id <project-id> --tag <lowercase-kebab-case>
ks project tag list --id <project-id>
ks project alias <add|remove> --id <project-id> --alias <single-line-name>
ks project alias list --id <project-id>
ks project describe --id <project-id> (--summary <single-line-text>|--clear)
ks project lifecycle set --id <project-id> --state <active|paused|archived>
ks project inspect --id <project-id>
ks project resolve --path <path>
ks project check --id <project-id>
ks project migrate --id <project-id> --to-layout worksite [--extract-context] [--preserve-worktree] [--apply --plan <plan-id>]
ks project adopt --source <external-git-root> --workspace <id> --name <kebab-case-name> [--tag <tag>] [--alias <name>] [--summary <text>] [--preserve-worktree]
ks project adopt --apply --plan <plan-id>
ks project list [--tag <tag>] [--lifecycle <state>]
ks project search --query <text> [--tag <tag>] [--lifecycle <state>]
ks spark configure --path <sparks-directory>
ks spark list
ks spark find --query <text>
ks spark inspect --id <spark-id>
ks spark create --title <title>
ks spark append-section --id <spark-id> --heading <heading> --content-file <path>
ks spark check --id <spark-id>
```

`ks spark` 的默认目录从已登记工作空间的共同父目录推导为 `sparks/`；具体根目录由
用户配置，不写死在 Skill 文档中。工作空间不共享共同父目录时，必须先由用户确认，
再使用 `ks spark configure` 设置目录。

火花文件每条一个 Markdown 文件。`append-section` 只允许通过临时内容文件追加到文末：
`--heading` 传章节标题，`--content-file` 只能传章节正文，不能以相同 Markdown 标题开头。
CLI 检测到重复标题会拒绝写入，而不会静默删除或改写用户正文。用户明确要求修复、删除、改写
或整理既有火花时，先用 `inspect` 确定唯一 `spark id` 和规范路径，随后才可直接编辑该文件，
并必须再次 `inspect` 回读；“记录、补充、追加”仍只使用 `append-section`。完整边界见
[受管文件访问工作流](../ks/references/managed-file-access-workflow.md)。现阶段支持
全局火花和可检索内容，不把火花移动到项目 `ks-context/`；项目关联、生命周期迁移和知识库
转化仍是后续能力。

`project register` 只接管用户明确指定的、已经位于受管工作空间中的既有 Git 仓库；
它不移动文件、不写入项目本体。对工作空间外的 Git 仓库，必须走 `project adopt`，
不能先手工移动再假装它已经是受管项目。

`project update` 仅修正已有登记，不移动项目文件；必须用 `--id` 指定登记项。指定的新路径
必须是目标工作空间内已存在的 Git 仓库，避免登记与实际项目脱节。

## 外部项目接手

用户明确要求把工作空间外的 Git 项目纳入 KS 时，先运行不带 `--apply` 的
`ks project adopt --source <external-git-root> --workspace <id> --name <name> ... --json`。
CLI 必须返回源路径、目标 `<name>-proj/<name>/`、项目语义索引、Git HEAD/分支/remote、
工作树状态和 `plan id`。只展示计划，不移动文件、不登记项目。

默认只接手干净的 Git 工作树。若 CLI 报告未提交变更，必须向用户展示变更并等待其明确
授权保留；只有得到明确授权时才能重新生成带 `--preserve-worktree` 的计划。不得擅自
提交、stash、丢弃、复制或清理变更。

用户确认计划后，才运行 `ks project adopt --apply --plan <plan-id> --json`。完成后必须运行
`inspect`、`check`、内层 `git status --short --branch` 和外层 `git ls-files` 验收，并回报
实际新路径和保留的 Git remote。若源在其他文件系统，CLI 会拒绝接手；此时必须请用户先
决定如何移动到目标文件系统，不得自行改用复制或删除源目录。

## 迁入开发现场

1. 先运行 `ks project resolve --path <用户给出的路径> --json` 或 `ks project inspect --id <id> --json`，确认登记身份、工作空间和当前布局；随后运行 `ks project check --id <id> --json`。只有 `compliant: true` 时，才可把它当作符合标准的开发现场。
2. 只有用户明确要求迁入时，运行不带 `--apply` 的 `ks project migrate --id <id> --to-layout worksite [--extract-context] --json`，展示计划中的源路径、`<project-name>-proj/<project-name>/` 目标、原 Git HEAD/分支/remote 和 `planId`。
3. 若计划要求 `--extract-context`，明确说明现有 `ks-context/` 将从项目本体 Git 抽离到外层；不得把它留在项目本体和外层各复制一份。
4. 若内层 Git 有未提交改动，默认停止并展示文件列表。只有用户明确确认“保留这些改动并迁入”时，才在预检和执行中加入 `--preserve-worktree`；不得擅自提交、stash、丢弃或清理。
5. 等用户确认该计划后，才运行 `ks project migrate --id <id> --to-layout worksite [--extract-context] [--preserve-worktree] --apply --plan <planId> --json`。
6. 完成后用 `inspect`、`resolve --path <project>-proj/<project>`、内层 `git status --short --branch` 和外层 `git ls-files` 验收。若抽离了原本被内层 Git 追踪的上下文，向用户明确报告内层出现的删除变更，等待正常源码提交流程处理；不得擅自丢弃、stash 或提交。

迁移预检默认会拒绝 `ks-context/` 之外的未提交改动，防止 CLI 隐式搬运用户正在编辑的源码；
`--preserve-worktree` 仅用于用户已审阅计划并明确要求保留改动的迁入。
`project migrate` 的无 `--apply` 调用只输出计划；`--apply` 必须带同一次计划返回的
`--plan`，计划内容变化后必须重新预检。

后续接口会覆盖副本/镜像关系、火花关联和知识关联。
