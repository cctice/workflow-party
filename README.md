# Workflow Party (Marketplace)

[![version](https://img.shields.io/badge/version-0.1.3-22d3EE)](https://github.com/cctice/workflow-party) [![license](https://img.shields.io/badge/license-MIT-3B82F6)](https://github.com/cctice/workflow-party/blob/master/LICENSE) [![tests](https://img.shields.io/badge/tests-19%20passing-brightgreen)](https://github.com/cctice/workflow-party) [![plugins](https://img.shields.io/badge/plugins-3_listed-8B5CF6)](https://github.com/cctice/workflow-party/blob/master/.claude-plugin/marketplace.json)

Personal agent workflow marketplace maintained by cctice. This repository
keeps the marketplace index and verified release artifacts; plugin sources
live in their own repositories. The marketplace is discovery and entry, not
a second home for plugin source code.

## Marketplace Positioning

- Discovery: every listing below is a ready entry to a real plugin release.
- Entry: each listing points to where the plugin actually lives and ships.
- Listing guide: to list a plugin, add an entry to both marketplace
  manifests (`.claude-plugin/marketplace.json` and
  `.agents/plugins/marketplace.json`) and keep `npm test` green.

## Sister Repositories

`kaleidosphere` is the product repository and the source of truth for
plugin releases. `workflow-party` (this repository) is its marketplace
sister: listings point back to the product repo, and each release mirrors
one verified artifact here.

```text
kaleidosphere (product repo, 0.4.2)         workflow-party (this marketplace)
├─ plugins/afk/ ──── listing points to ───▶ afk 0.1.0 (bundled-in-kaleidosphere)
└─ release .tgz ──── mirror per release ─▶ plugins/kaleidosphere/resources/
        ▲                                              │
        └──── version alignment: index follows the product repo (0.4.2)
```

## Listings

| Listing | Version | Source | Note |
| --- | --- | --- | --- |
| kaleidosphere | 0.4.2 | `./plugins/kaleidosphere` | verified artifact `plugins/kaleidosphere/resources/kaleidosphere-0.4.2.tgz` |
| kfc-plugin | 0.1.1 | `./plugins/kfc-plugin` | verified artifact `plugins/kfc-plugin/resources/kfc-plugin-0.1.1.tgz` |
| afk | 0.1.0 | `cctice/kaleidosphere` → `plugins/afk/` | bundled-in-kaleidosphere; discovery entry only |

`afk` ships inside kaleidosphere as its built-in workflow engine. This
marketplace lists it for discovery and points to
`https://github.com/cctice/kaleidosphere/tree/master/plugins/afk/`; its
source is not mirrored here.

## Manifest Tests

`npm test` validates the marketplace manifests: entry format, version
fields, listing parity across manifests, and the presence of verified
release artifacts.
