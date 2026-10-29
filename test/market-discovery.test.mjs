// 市场发现机制测试（维护心跳包·五轮）：搜索/分类过滤/下载量排序/回填——从零到有的发现面。
//   ① 分类归一：agents 版 "Developer Tools" 与索引版 "developer-tools" 同类
//   ② 搜索：不区分大小写子串命中 name/description/category，空查询不出假结果
//   ③ 排序：downloads 降序为默认序，name 字典序可选
//   ④ 下载台账覆盖门：每个非 bundled 市场条目在 stats/downloads.json 有 key
//   ⑤ bump 回填：+N 持久化并刷新 updatedAt（临时根上跑，不动真台账）
//   ⑥ CLI 冒烟：search/info/stats 子命令真实进程跑通
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadCatalog, searchPlugins, listPlugins, bumpDownloads, normalizeCategory } from "../scripts/market.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalog = loadCatalog(root);

test("分类归一：大小写与空格不影响类别判定", () => {
  assert.equal(normalizeCategory("Developer Tools"), "developer-tools");
  assert.equal(normalizeCategory("DEVELOPER-TOOLS"), "developer-tools");
});

test("搜索：描述关键词命中（coordination → kaleidosphere）", () => {
  const hits = searchPlugins(catalog, "coordination");
  assert.ok(hits.some((p) => p.name === "kaleidosphere"));
});

test("搜索：不区分大小写（KFC → kfc-plugin）", () => {
  assert.ok(searchPlugins(catalog, "KFC").some((p) => p.name === "kfc-plugin"));
});

test("搜索：空查询与未命中都返回空（不编造结果）", () => {
  assert.deepEqual(searchPlugins(catalog, ""), []);
  assert.deepEqual(searchPlugins(catalog, "不存在的插件xyz"), []);
});

test("评分：名称整词命中 > 描述命中（字段权重可解释，结果带 score/fields）", () => {
  const hits = searchPlugins(catalog, "kaleidosphere");
  assert.equal(hits[0].name, "kaleidosphere");
  assert.ok(hits[0].fields.includes("name"));
  assert.ok(hits[0].score > 0);
  // "coordination" 只在描述里（权重 2），名称命中者的分必须更高
  const descHit = searchPlugins(catalog, "coordination")[0];
  assert.ok(descHit.fields.includes("description"));
  assert.ok(hits[0].score > descHit.score, `名称命中 ${hits[0].score} 应高于描述命中 ${descHit.score}`);
});

test("评分：多 token 是 AND 语义——缺 token 的条目不出席", () => {
  assert.ok(searchPlugins(catalog, "workflow").length >= 2, "前置：workflow 独立命中至少两条");
  const hits = searchPlugins(catalog, "personal workflow");
  assert.ok(hits.some((p) => p.name === "kfc-plugin"));
  assert.ok(!hits.some((p) => p.name === "afk"), "afk 缺 personal token，AND 语义应出局");
});

test("评分：同分下载量 tie-break；稀有 token 单条贡献高于公共 token", () => {
  const byTools = searchPlugins(catalog, "tools"); // 三条目 category 整词命中 → 同分
  assert.equal(byTools.length, catalog.entries.length);
  for (let i = 1; i < byTools.length; i++) {
    assert.ok(
      byTools[i - 1].score > byTools[i].score ||
        (byTools[i - 1].score === byTools[i].score && byTools[i - 1].downloads >= byTools[i].downloads),
      "排序必须分值降序、同分下载量降序"
    );
  }
  const rare = searchPlugins(catalog, "kaleidosphere")[0].score;
  const common = searchPlugins(catalog, "tools")[0].score;
  assert.ok(rare > common, `稀有 token 贡献 ${rare} 应高于公共 token ${common}（逆文档频）`);
});

test("分类过滤：developer-tools 全量在列，错误分类为空", () => {
  assert.equal(listPlugins(catalog, { category: "developer-tools" }).length, catalog.entries.length);
  assert.deepEqual(listPlugins(catalog, { category: "no-such-cat" }), []);
});

test("排序：默认按下载量降序、同量按名称；--sort name 走字典序", () => {
  const byDownloads = listPlugins(catalog);
  for (let i = 1; i < byDownloads.length; i++) {
    assert.ok(byDownloads[i - 1].downloads > byDownloads[i].downloads ||
      (byDownloads[i - 1].downloads === byDownloads[i].downloads &&
        byDownloads[i - 1].name.localeCompare(byDownloads[i].name) <= 0), "默认序破坏");
  }
  const byName = listPlugins(catalog, { sort: "name" }).map((p) => p.name);
  assert.deepEqual(byName, [...byName].sort((a, b) => a.localeCompare(b)));
});

test("下载台账覆盖门：每个非 bundled 条目都有 counts key", () => {
  const stats = JSON.parse(fs.readFileSync(path.join(root, "stats", "downloads.json"), "utf8"));
  const keys = new Set(Object.keys(stats.counts));
  for (const p of catalog.entries.filter((e) => !e["bundled-in-kaleidosphere"])) {
    assert.ok(keys.has(`${p.name}@${p.version}`), `${p.name}@${p.version} 台账缺 key`);
  }
});

test("bump 回填：+N 持久化并刷新 updatedAt（临时根，不动真台账）", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wfp-market-"));
  fs.mkdirSync(path.join(tmp, ".claude-plugin"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "stats"), { recursive: true });
  fs.copyFileSync(path.join(root, ".claude-plugin", "marketplace.json"), path.join(tmp, ".claude-plugin", "marketplace.json"));
  fs.copyFileSync(path.join(root, "stats", "downloads.json"), path.join(tmp, "stats", "downloads.json"));
  const first = bumpDownloads(tmp, "kfc-plugin", 3);
  assert.equal(first, 3, "0+3");
  assert.equal(bumpDownloads(tmp, "kfc-plugin"), 4, "默认 +1");
  assert.equal(bumpDownloads(tmp, "no-such-plugin"), null, "未知名拒绝");
  const persisted = JSON.parse(fs.readFileSync(path.join(tmp, "stats", "downloads.json"), "utf8"));
  assert.equal(persisted.counts["kfc-plugin@0.1.1"], 4);
  assert.match(persisted.updatedAt, /^\d{4}-\d{2}-\d{2}$/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("CLI 冒烟：search/info/stats 子命令真实进程跑通", () => {
  const run = (args) => execFileSync(process.execPath, [path.join(root, "scripts", "market.mjs"), ...args], { encoding: "utf8" });
  assert.match(run(["search", "kfc"]), /kfc-plugin/);
  assert.match(run(["info", "kaleidosphere"]), /kaleidosphere@/);
  assert.match(run(["stats"]), /kaleidosphere@0\.4\.2/);
  assert.match(run(["list", "--category", "developer-tools"]), /kfc-plugin/);
});
