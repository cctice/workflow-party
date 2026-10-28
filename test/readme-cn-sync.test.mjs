// README_CN 双语同步门（维护心跳包·六轮）：徽章/产物路径漂移此前只有英文版被门看守——
// 中文版改了徽章、换了产物路径、删了条目行都不会红。本门把中文版钉进同一道门：
// ①三徽章（version/plugins/tests）值与英文版逐个相等（同真源同值，不许双语各说各话）；
// ②市场条目表逐条对账（每个清单条目在中文版有同名同版本行）；
// ③产物 .tgz 路径引用集合双语一致（中文版引用的产物不许比英文版多或少）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
const readmeCn = fs.readFileSync(path.join(root, "README_CN.md"), "utf8");
const index = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin", "marketplace.json"), "utf8"));

const badge = (source, name) => source.match(new RegExp(`badge\\/${name}-([^)-]+)`))?.[1];

test("README_CN 三徽章在位且与英文版同值（同真源不许双语漂移）", () => {
  for (const name of ["version", "plugins", "tests"]) {
    const en = badge(readme, name);
    const cn = badge(readmeCn, name);
    assert.ok(en, `README 缺 ${name} 徽章`);
    assert.ok(cn, `README_CN 缺 ${name} 徽章（双语面裸奔）`);
    assert.equal(cn, en, `README_CN ${name} 徽章（${cn}）与英文版（${en}）漂移`);
  }
  // 中文版徽章同时必须对得上真源（防双语一起错）
  assert.equal(badge(readmeCn, "version"), index.metadata.version);
  assert.equal(Number(badge(readmeCn, "plugins").replace(/_listed/, "")), index.plugins.length);
});

test("README_CN 市场条目表逐条对账：每个清单条目同名同版本", () => {
  for (const entry of index.plugins) {
    const row = new RegExp(`\\|\\s*${entry.name}\\s*\\|\\s*${entry.version}\\s*\\|`);
    assert.ok(row.test(readmeCn), `README_CN 缺 ${entry.name}@${entry.version} 条目行（表漂移）`);
    assert.ok(row.test(readme), `README 缺 ${entry.name}@${entry.version} 条目行（对账基准失效）`);
  }
});

test("README_CN 产物 .tgz 引用集合与英文版一致（产物路径漂移即红）", () => {
  const refs = (source) => new Set([...source.matchAll(/plugins\/[\w-]+\/resources\/[\w.-]+\.tgz/g)].map((m) => m[0]));
  const en = refs(readme);
  const cn = refs(readmeCn);
  assert.ok(en.size > 0, "README 无产物引用（对账基准失效）");
  assert.deepEqual([...cn].sort(), [...en].sort(), "双语产物路径引用集合漂移");
});
