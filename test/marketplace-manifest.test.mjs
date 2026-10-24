import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 两份市场清单：索引版（带版本字段）与 agents 版（本地安装描述）
const indexPath = path.join(root, ".claude-plugin", "marketplace.json");
const agentsPath = path.join(root, ".agents", "plugins", "marketplace.json");
const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
const agents = JSON.parse(fs.readFileSync(agentsPath, "utf8"));

const readJson = (...parts) => JSON.parse(fs.readFileSync(path.join(root, ...parts), "utf8"));
const SEMVER = /^\d+\.\d+\.\d+$/;

const indexPlugins = index.plugins;
const agentsPlugins = agents.plugins;
const byName = (list) => Object.fromEntries(list.map((p) => [p.name, p]));

test("marketplace identity: both manifests parse and declare workflow-party", () => {
  assert.equal(index.name, "workflow-party");
  assert.equal(agents.name, "workflow-party");
  assert.ok(Array.isArray(indexPlugins) && indexPlugins.length >= 3);
  assert.ok(Array.isArray(agentsPlugins) && agentsPlugins.length >= 3);
});

test("index entry format: name/version/description/author/source/category all present and well-formed", () => {
  for (const entry of indexPlugins) {
    assert.equal(typeof entry.name, "string", `${entry.name}: name must be a string`);
    assert.ok(entry.name.length > 0);
    assert.match(entry.version, SEMVER, `${entry.name}: version must be x.y.z`);
    assert.ok(typeof entry.description === "string" && entry.description.length > 0);
    assert.ok(entry.author && typeof entry.author.name === "string" && entry.author.name.length > 0);
    assert.ok(typeof entry.source === "string" && entry.source.length > 0);
    assert.ok(typeof entry.category === "string" && entry.category.length > 0);
  }
});

test("afk listing exists in both manifests, marked bundled-in-kaleidosphere, pointing at the kaleidosphere repo", () => {
  const afkIndex = byName(indexPlugins).afk;
  const afkAgents = byName(agentsPlugins).afk;
  assert.ok(afkIndex, "afk entry missing from index manifest");
  assert.ok(afkAgents, "afk entry missing from agents manifest");

  assert.equal(afkIndex.version, "0.1.0");
  assert.equal(afkIndex.author.name, "cctice");
  assert.match(afkIndex.source, /^https:\/\/github\.com\/cctice\/kaleidosphere\/tree\/master\/plugins\/afk\/?$/);
  assert.equal(afkIndex["bundled-in-kaleidosphere"], true);

  const sourceUrl = typeof afkAgents.source === "object" ? afkAgents.source.path : afkAgents.source;
  assert.match(sourceUrl, /^https:\/\/github\.com\/cctice\/kaleidosphere\/tree\/master\/plugins\/afk\/?$/);
  assert.equal(afkAgents["bundled-in-kaleidosphere"], true);
});

test("afk is discovery-only: not mirrored under plugins/", () => {
  assert.equal(fs.existsSync(path.join(root, "plugins", "afk")), false,
    "marketplace must not mirror afk source; it is bundled in kaleidosphere");
});

test("kaleidosphere version alignment: index, root plugin.json, and bundled manifests all say 0.4.2", () => {
  const expected = "0.4.2";
  const ksIndex = byName(indexPlugins).kaleidosphere;
  assert.equal(ksIndex.version, expected);
  assert.equal(readJson("plugin.json").version, expected);
  assert.equal(readJson("plugins", "kaleidosphere", ".claude-plugin", "plugin.json").version, expected);
  assert.equal(readJson("plugins", "kaleidosphere", ".codex-plugin", "plugin.json").version, expected);
});

test("verified artifacts: each locally-listed plugin ships plugins/<name>/resources/<name>-<version>.tgz", () => {
  for (const entry of indexPlugins) {
    if (entry["bundled-in-kaleidosphere"]) continue; // 远端条目不在本仓镜像产物
    const tgz = path.join(root, "plugins", entry.name, "resources", `${entry.name}-${entry.version}.tgz`);
    assert.ok(fs.existsSync(tgz), `missing verified artifact: ${tgz}`);
    // 与本地清单版本一致（本地安装条目的版本 = 捆绑副本清单版本）
    const bundled = readJson("plugins", entry.name, ".claude-plugin", "plugin.json");
    assert.equal(bundled.version, entry.version, `${entry.name}: index version must match bundled manifest`);
  }
});

test("agents manifest local sources resolve to existing directories", () => {
  for (const entry of agentsPlugins) {
    const src = entry.source;
    if (src && typeof src === "object" && src.source === "local") {
      assert.ok(fs.existsSync(path.join(root, src.path)), `local source does not exist: ${src.path}`);
    }
  }
});

test("plugin parity: both manifests list the same names, with no duplicates", () => {
  const indexNames = indexPlugins.map((p) => p.name).sort();
  const agentsNames = agentsPlugins.map((p) => p.name).sort();
  assert.deepEqual(indexNames, agentsNames);
  assert.equal(new Set(indexNames).size, indexNames.length, "duplicate names in index manifest");
  assert.equal(new Set(agentsNames).size, agentsNames.length, "duplicate names in agents manifest");
  assert.deepEqual(indexNames, ["afk", "kaleidosphere", "kfc-plugin"]);
});

test("marketplace metadata: index metadata.version is a semver bump (0.1.2)", () => {
  assert.ok(index.metadata && index.metadata.version);
  assert.match(index.metadata.version, SEMVER);
  assert.equal(index.metadata.version, "0.1.2");
});
