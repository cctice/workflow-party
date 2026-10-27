// 版本联动测试：市场索引与插件源仓的版本必须由源驱动，而非手工各改各的。
//
// 此前的链路缺口（manifest-sync 管双清单对齐、artifact-integrity 管 tgz
// 内容）：
//   源目录 plugin.json（若有）→ marketplace 版本号 → tgz 文件名 → tgz 内清单
// 四个点没有一条测试串起来——kaleidosphere 源目录甚至没有 plugin.json，
// 版本号全靠手填市场清单。
//
// 本文件的契约（三点一线）：
// 1. 每个本地产物插件必须有源 plugin.json（版本真源）；
// 2. 源 plugin.json.version === 市场条目 version === tgz 文件名版本；
// 3. 源 plugin.json 的 name/description/author 与市场条目字段一致；
// 4. 版本格式为 semver x.y.z（给未来"源仓 tag 驱动条目更新"留锚：
//    规则定为 v<version> tag，见 docs/release-runbook.md）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const index = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin", "marketplace.json"), "utf8"));
const localListings = index.plugins.filter((p) => !p["bundled-in-kaleidosphere"]);

test("local listings each have a source plugin.json as version source of truth", () => {
  assert.ok(localListings.length >= 2, "expected at least 2 local listings");
  for (const entry of localListings) {
    const sourceDir = path.join(root, entry.source.replace(/^\.\//, ""));
    const manifestPath = path.join(sourceDir, "plugin.json");
    assert.ok(
      fs.existsSync(manifestPath),
      `${entry.name}: 源目录缺 plugin.json（版本真源）——升版本没有单一改动点`
    );
  }
});

test("version line: source plugin.json === marketplace entry === tgz filename", () => {
  const semver = /^\d+\.\d+\.\d+$/;
  for (const entry of localListings) {
    const sourceDir = path.join(root, entry.source.replace(/^\.\//, ""));
    const source = JSON.parse(fs.readFileSync(path.join(sourceDir, "plugin.json"), "utf8"));

    assert.match(entry.version, semver, `${entry.name}: marketplace 版本 ${entry.version} 不是 semver`);
    assert.match(source.version, semver, `${entry.name}: 源 plugin.json 版本 ${source.version} 不是 semver`);
    assert.equal(
      source.version,
      entry.version,
      `${entry.name}: 源版本 ${source.version} ≠ 市场版本 ${entry.version}——源才是真源，先改源再发版`
    );

    const artifact = fs.readdirSync(path.join(sourceDir, "resources"))
      .find((f) => f.endsWith(".tgz"));
    assert.ok(artifact, `${entry.name}: resources/ 无 tgz 产物`);
    const fileVersion = artifact.replace(/\.tgz$/, "").split("-").pop();
    assert.equal(
      fileVersion,
      entry.version,
      `${entry.name}: tgz 文件名版本 ${fileVersion} ≠ 市场版本 ${entry.version}`
    );
  }
});

test("field parity: source plugin.json name/description/author match marketplace entry", () => {
  for (const entry of localListings) {
    const sourceDir = path.join(root, entry.source.replace(/^\.\//, ""));
    const source = JSON.parse(fs.readFileSync(path.join(sourceDir, "plugin.json"), "utf8"));

    assert.equal(source.name, entry.name, `${entry.name}: 源/市场 name 不一致`);
    assert.equal(
      source.description,
      entry.description,
      `${entry.name}: 源/市场 description 不一致（改源后未同步市场条目）`
    );
    assert.equal(source.author?.name, entry.author?.name, `${entry.name}: 源/市场 author 不一致`);
    // category 真源兼容两种声明位：顶层 category（kaleidosphere）或
    // interface.category（kfc-plugin 风格），归一化后比对
    const sourceCategory = source.category ?? source.interface?.category;
    if (sourceCategory || entry.category) {
      const norm = (v) => (v ?? "").toLowerCase().replace(/[\s_]+/g, "-");
      assert.equal(
        norm(sourceCategory),
        norm(entry.category),
        `${entry.name}: 源/市场 category 不一致`
      );
    }
  }
});
