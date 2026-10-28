#!/usr/bin/env node
// market.mjs —— 市场发现机制 CLI（维护心跳包·五轮：搜索/分类/下载量从零起步）
//
// 背景：市场此前只有"清单存在性"，没有任何发现面——想找插件只能肉眼读 JSON；
// 分类过滤、关键词搜索、下载量排序全缺。
//
// 用法：
//   node scripts/market.mjs list [--category developer-tools] [--sort name|downloads] [--json]
//   node scripts/market.mjs search <关键词...> [--json]     # 名称/描述/分类 不区分大小写子串
//   node scripts/market.mjs info <name> [--json]            # 条目 + 下载量 + 来源
//   node scripts/market.mjs stats [--json]                  # 下载量台账全量
//   node scripts/market.mjs bump <name> [--by N]            # 安装/发放回填下载量（默认 +1）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 分类归一：大小写/空格-连字符 归一（"Developer Tools" === "developer-tools"） */
export function normalizeCategory(c) {
  return String(c || "").trim().toLowerCase().replace(/\s+/g, "-");
}

/** 读目录：市场索引 + 下载台账（注入 repoRoot 便于测试用临时根） */
export function loadCatalog(repoRoot = root) {
  const index = JSON.parse(fs.readFileSync(path.join(repoRoot, ".claude-plugin", "marketplace.json"), "utf8"));
  let downloads = {};
  try {
    downloads = JSON.parse(fs.readFileSync(path.join(repoRoot, "stats", "downloads.json"), "utf8")).counts || {};
  } catch { /* 台账未建：下载量按 0，info/stats 如实报 */ }
  return {
    entries: index.plugins.map((p) => ({
      ...p,
      category: normalizeCategory(p.category),
      downloads: downloads[`${p.name}@${p.version}`] ?? 0,
    })),
    downloadsRaw: downloads,
  };
}

/** 关键词搜索：name/description/category 不区分大小写子串匹配，按下载量降序再按名称 */
export function searchPlugins(catalog, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return [];
  return catalog.entries
    .filter((p) => [p.name, p.description, p.category].some((f) => String(f || "").toLowerCase().includes(q)))
    .sort(cmpDownloads);
}

const cmpDownloads = (a, b) => (b.downloads - a.downloads) || a.name.localeCompare(b.name);

/** 列表：分类过滤 + 排序（downloads 降序默认；name 按字典序） */
export function listPlugins(catalog, { category, sort = "downloads" } = {}) {
  let entries = [...catalog.entries];
  if (category) entries = entries.filter((p) => p.category === normalizeCategory(category));
  entries.sort(sort === "name" ? (a, b) => a.name.localeCompare(b.name) : cmpDownloads);
  return entries;
}

/** 回填下载量：+by（默认 1），同步 updatedAt；返回新值（未知名 → null） */
export function bumpDownloads(repoRoot, name, by = 1) {
  const index = JSON.parse(fs.readFileSync(path.join(repoRoot, ".claude-plugin", "marketplace.json"), "utf8"));
  const entry = index.plugins.find((p) => p.name === name);
  if (!entry) return null;
  const statsPath = path.join(repoRoot, "stats", "downloads.json");
  const stats = JSON.parse(fs.readFileSync(statsPath, "utf8"));
  const key = `${entry.name}@${entry.version}`;
  stats.counts[key] = (stats.counts[key] ?? 0) + by;
  stats.updatedAt = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(path.dirname(statsPath), { recursive: true });
  fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2) + "\n");
  return stats.counts[key];
}

// ---- CLI ----
function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json" || a === "--category" || a === "--sort" || a === "--by") {
      if (a === "--json") flags.json = true;
      else flags[a.slice(2)] = argv[++i];
    } else pos.push(a);
  }
  return { flags, pos };
}

const render = (p) => `${p.name}@${p.version}  [${p.category}]  ↓${p.downloads}  ${p.description?.slice(0, 60) || ""}`;

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, pos } = parseArgs(rest);
  const catalog = loadCatalog();
  if (cmd === "list") {
    const items = listPlugins(catalog, { category: flags.category, sort: flags.sort });
    if (flags.json) console.log(JSON.stringify(items, null, 2));
    else if (items.length) items.forEach((p) => console.log(render(p)));
    else console.log("(空)");
  } else if (cmd === "search") {
    const items = searchPlugins(catalog, pos.join(" "));
    if (flags.json) console.log(JSON.stringify(items, null, 2));
    else if (items.length) items.forEach((p) => console.log(render(p)));
    else console.log(`未命中：${pos.join(" ")}`);
  } else if (cmd === "info") {
    const p = catalog.entries.find((e) => e.name === pos[0]);
    if (!p) { console.error(`未找到插件：${pos[0]}`); process.exit(1); }
    console.log(flags.json ? JSON.stringify(p, null, 2) : render(p));
  } else if (cmd === "stats") {
    if (flags.json) console.log(JSON.stringify(catalog.downloadsRaw, null, 2));
    else Object.entries(catalog.downloadsRaw).forEach(([k, v]) => console.log(`${k}  ↓${v}`));
  } else if (cmd === "bump") {
    const n = bumpDownloads(root, pos[0], Number(flags.by) || 1);
    if (n == null) { console.error(`未找到插件：${pos[0]}`); process.exit(1); }
    console.log(`${pos[0]} 下载量 → ${n}`);
  } else {
    console.log("用法：market list [--category c] [--sort name|downloads] | search <q> | info <name> | stats | bump <name> [--by N]");
    process.exit(cmd ? 1 : 0);
  }
}
