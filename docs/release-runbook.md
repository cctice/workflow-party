# 发布 Runbook（build → sha256 → 双清单 → commit）

> 维护包 workflow-party 三轮：发布流程从此文档化，且受
> `test/release-runbook.test.mjs` 漂移门保护——runbook 引用的路径/命令
> 与仓库实际结构漂移即测试挂。**照着敲就能发版，照不着敲就发不出。**

## 0. 前置

- 本仓所有改动已合入 `master`，`node --test` 全绿；
- 要发版的插件版本号已在**源 plugin.json** 改好（版本真源，见
  `test/version-linkage.test.mjs`）。

## 1. 构建产物（插件形态 tgz）

产物必须是**插件包**，不是仓库快照（沙箱安装门 `test/sandbox-install.test.mjs`
会真装一遍：plugin.json 身份 + skills 可发现缺一不可）：

```bash
# kaleidosphere（示例版本 0.4.2，替换为真实版本）
stage=$(mktemp -d)/package && mkdir -p "$stage"
(cd plugins/kaleidosphere && cp -R plugin.json README.md README_CN.md skills "$stage/")
find "$stage" -name .DS_Store -delete
(cd "$(dirname "$stage")" && COPYFILE_DISABLE=1 tar czf "$OLDPWD/plugins/kaleidosphere/resources/kaleidosphere-<VER>.tgz" package)
rm -rf "$(dirname "$stage")"

# kfc-plugin 同理：cp -R plugin.json README.md skills
```

产物命名：`plugins/<name>/resources/<name>-<version>.tgz`（version-linkage
门强制文件名版本 = 源版本）。

## 2. 计算 sha256 并写入索引清单

```bash
shasum -a 256 plugins/<name>/resources/<name>-<version>.tgz
```

把 `sha256:<hex>` 写入 `.claude-plugin/marketplace.json` 对应条目的
`integrity` 字段；同一条目的 `version` 改为 `<version>`。
`.agents/plugins/marketplace.json` 无 integrity 字段，但 category 等字段
由 `test/manifest-sync.test.mjs` 字段级对齐门看护。

## 3. 全量验证（一道命令）

```bash
node --test
```

六道门全过才算产物就绪：市场清单解析 / 双清单字段同步 / README 徽章 /
产物内容级完整性 / 版本三点一线 / 沙箱安装运行。
若 README tests 徽章数漂移，先改 README（徽章门会点名正确数字）。

## 4. 提交

```bash
git add plugins/<name>/resources .claude-plugin/marketplace.json README.md
git commit -m "release: <name>@<version> 产物重建 + integrity 更新"
```

## 5. 版本联动规则（tag 驱动，目标态）

理想流程是源仓打 `v<version>` tag → 本仓清单条目自动跟随。当前半自动：
源 plugin.json 版本即真源，升版本 = 改源 → 重建产物 → 更新索引。
version-linkage 门的 semver 校验为 tag 规则（`v` + semver）预留锚点。

## 事故回滚

产物或 integrity 写坏：`git revert` 对应 release commit 即可，产物与
清单在同一提交内原子回滚。
