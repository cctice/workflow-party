// 双清单字段级同步防线：name 级 parity 已有（marketplace-manifest.test.mjs），
// 但手工双写仍会在字段层漂移——category 改了一边、source 路径改了一边、
// README 徽章忘了跟——都是“清单还能解析、测试还全绿”的静默漂移。
// 本文件把同步契约压到字段级，并把 README 徽章纳入同一道门。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const indexPath = path.join(root, ".claude-plugin", "marketplace.json");
const agentsPath = path.join(root, ".agents", "plugins", "marketplace.json");
const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
const agents = JSON.parse(fs.readFileSync(agentsPath, "utf8"));

const byName = (list) => Object.fromEntries(list.map((p) => [p.name, p]));
const indexBy = byName(index.plugins);
const agentsBy = byName(agents.plugins);

test("category sync: every plugin agrees across manifests after normalization", () => {
  for (const entry of index.plugins) {
    const other = agentsBy[entry.name];
    assert.ok(other, `${entry.name}: missing from agents manifest`);
    assert.ok(entry.category, `${entry.name}: index entry has no category`);
    assert.ok(other.category, `${entry.name}: agents entry has no category`);
    const normalize = (value) => value.toLowerCase().replace(/[\s_]+/g, "-");
    assert.equal(
      normalize(other.category),
      normalize(entry.category),
      `${entry.name}: category drifted between manifests (index="${entry.category}", agents="${other.category}")`
    );
  }
});

test("source sync: local paths and remote URLs agree across manifests", () => {
  for (const entry of index.plugins) {
    const other = agentsBy[entry.name];
    assert.ok(other, `${entry.name}: missing from agents manifest`);

    const indexSource = entry.source;
    const agentsSource = other.source;
    assert.ok(agentsSource, `${entry.name}: agents entry has no source`);

    if (typeof indexSource === "string" && indexSource.startsWith("./plugins/")) {
      // 本地安装条目：两边必须指向同一个相对目录
      assert.equal(
        agentsSource.source,
        "local",
        `${entry.name}: index lists a local path but agents source is "${agentsSource.source}"`
      );
      assert.equal(
        agentsSource.path,
        indexSource,
        `${entry.name}: source path drifted (index="${indexSource}", agents="${agentsSource.path}")`
      );
      assert.ok(
        fs.existsSync(path.join(root, indexSource)),
        `${entry.name}: local source does not exist: ${indexSource}`
      );
    } else {
      // 远端条目：两边必须指向同一个 URL
      const agentsUrl = typeof agentsSource === "object" ? agentsSource.path : agentsSource;
      assert.equal(agentsUrl, indexSource, `${entry.name}: remote source URL drifted`);
    }
  }
});

test("README badges stay consistent with manifests and the real test count", () => {
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");

  // version 徽章 == 市场索引 metadata.version（发布动作必须同步刷徽章）
  const versionBadge = readme.match(/badge\/version-(\d+\.\d+\.\d+)-/);
  assert.ok(versionBadge, "README has no version badge");
  assert.equal(versionBadge[1], index.metadata.version,
    `README version badge (${versionBadge[1]}) drifted from marketplace metadata.version (${index.metadata.version})`);

  // plugins 徽章 == 双清单实际条目数
  const pluginsBadge = readme.match(/badge\/plugins-(\d+)_listed-/);
  assert.ok(pluginsBadge, "README has no plugins badge");
  assert.equal(Number(pluginsBadge[1]), index.plugins.length,
    `README plugins badge (${pluginsBadge[1]}) drifted from manifest entries (${index.plugins.length})`);
  assert.equal(index.plugins.length, agents.plugins.length, "manifests disagree on plugin count");

  // tests 徽章 == test/*.mjs 顶层 test() 静态计数（新增用例忘刷徽章即红）
  const testFiles = fs.readdirSync(path.join(root, "test")).filter((f) => f.endsWith(".test.mjs"));
  let declared = 0;
  for (const file of testFiles) {
    const source = fs.readFileSync(path.join(root, "test", file), "utf8");
    declared += (source.match(/^test\(/gm) || []).length;
  }
  const testsBadge = readme.match(/badge\/tests-(\d+)%20passing-/);
  assert.ok(testsBadge, "README has no tests badge");
  assert.equal(Number(testsBadge[1]), declared,
    `README tests badge (${testsBadge[1]}) drifted from declared tests (${declared})`);
});
