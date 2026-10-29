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
# 一键重建（八轮起为正道）：staging→打包→指纹→双清单→provenance 登记，五步一条命令
node scripts/rebuild-artifacts.mjs --all          # 全部本地产物
node scripts/rebuild-artifacts.mjs kaleidosphere  # 只重建指定插件
```

脚本自动完成：staging（`plugin.json` + `README.md` + `README_CN.md` +
`skills`，存在即收）、`.DS_Store` 清除、`COPYFILE_DISABLE=1` 打包、sha256
回写双清单、`provenance.json` 自动登记（重建来源与日期），收尾自跑
`scripts/verify-artifacts.mjs` 三方对账，链不绿非零退出。
产物命名：`plugins/<name>/resources/<name>-<version>.tgz`（version-linkage
门强制文件名版本 = 源版本）。`test/rebuild-script.test.mjs` 看守脚本形态。

脚本失效时的人肉回退（与脚本行为逐条对齐，`test/release-runbook.test.mjs`
引用校验的载荷清单）：

```bash
# kaleidosphere（示例版本 0.4.2，替换为真实版本）
stage=$(mktemp -d)/package && mkdir -p "$stage"
(cd plugins/kaleidosphere && cp -R plugin.json README.md README_CN.md skills "$stage/")
find "$stage" -name .DS_Store -delete
(cd "$(dirname "$stage")" && COPYFILE_DISABLE=1 tar czf "$OLDPWD/plugins/kaleidosphere/resources/kaleidosphere-<VER>.tgz" package)
rm -rf "$(dirname "$stage")"

# kfc-plugin 同理：cp -R plugin.json README.md skills
```

## 2. 计算 sha256 并写入索引清单

重建脚本已自动回写；人肉回退时：

```bash
shasum -a 256 plugins/<name>/resources/<name>-<version>.tgz
```

把 `sha256:<hex>` 写入 `.claude-plugin/marketplace.json` 对应条目的
`integrity` 字段；同一条目的 `version` 改为 `<version>`；`provenance.json`
登记来源记录（脚本路径自动完成，人肉路径勿忘——verify:artifacts 会拦）。
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
