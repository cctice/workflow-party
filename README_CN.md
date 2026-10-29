# Workflow Party（工作流市场）

[![CI](https://github.com/cctice/workflow-party/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/cctice/workflow-party/actions/workflows/ci.yml)
[![version](https://img.shields.io/badge/version-0.1.3-22d3EE)](https://github.com/cctice/workflow-party) [![license](https://img.shields.io/badge/license-MIT-3B82F6)](https://github.com/cctice/workflow-party/blob/master/LICENSE) [![tests](https://img.shields.io/badge/tests-77%20passing-brightgreen)](https://github.com/cctice/workflow-party) [![plugins](https://img.shields.io/badge/plugins-3_listed-8B5CF6)](https://github.com/cctice/workflow-party/blob/master/.claude-plugin/marketplace.json)

cctice 维护的个人 Agent 工作流市场。本仓只保存市场索引与已验证的发布产物；
插件源码住在各自的仓库里。市场负责发现与入口，不收留插件源码的第二份家。

## 市场定位

- 发现：下面每个条目都是通向真实插件发布的现成入口。
- 入口：每个条目都指向插件真正居住与发布的位置。
- 上架指引：上架一个插件，在两份市场清单
  （`.claude-plugin/marketplace.json` 与 `.agents/plugins/marketplace.json`）
  各加一条条目，并保持 `npm test` 全绿。

## 姊妹仓关系

`kaleidosphere` 是产品仓，是插件发布的真源；`workflow-party`（本仓）是它的
市场姊妹仓：条目指回产品仓，每次发布镜像一份已验证产物到本仓。

```text
kaleidosphere（产品仓，0.4.2）              workflow-party（本仓，市场）
├─ plugins/afk/ ──── 上架条目指向 ────────▶ afk 0.1.0（bundled-in-kaleidosphere）
└─ 发布产物 .tgz ──── 每次发布镜像一份 ──▶ plugins/kaleidosphere/resources/
        ▲                                              │
        └──── 版本治理：市场清单随产品仓对齐（0.4.2）
```

## 上架条目

| 条目 | 版本 | 来源 | 备注 |
| --- | --- | --- | --- |
| kaleidosphere | 0.4.2 | `./plugins/kaleidosphere` | 已验证产物 `plugins/kaleidosphere/resources/kaleidosphere-0.4.2.tgz` |
| kfc-plugin | 0.1.1 | `./plugins/kfc-plugin` | 已验证产物 `plugins/kfc-plugin/resources/kfc-plugin-0.1.1.tgz` |
| afk | 0.1.0 | `cctice/kaleidosphere` → `plugins/afk/` | bundled-in-kaleidosphere；仅作发现入口 |

`afk` 作为万花镜内置的工作流引擎随其分发。市场为它建立发现条目，指向
`https://github.com/cctice/kaleidosphere/tree/master/plugins/afk/`；
本仓不镜像它的源码。

## 清单测试

`npm test` 校验市场清单：条目格式、版本字段、双清单一致性，以及已验证
发布产物的存在性。
