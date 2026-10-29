#!/usr/bin/env node
// build-site.mjs —— 静态市场站点生成（维护心跳包·九轮：CLI 之外无消费面）
//
// 痛点：市场只有 CLI 消费面——网页浏览、宿主内嵌市场都无处可去。
// 本脚本把市场索引+下载台账渲染成纯静态站点（零依赖、file:// 与任意静态托管同形）：
//   site/index.html        浏览页（数据内嵌 + 客户端搜索/分类/排序）
//   site/api/market.json   API 面（宿主内嵌消费，字段与 CLI list --json 同源）
// 输出确定性：同输入必同字节（site-gate 漂移门看守 committed 站点不过期）。
//
// 用法：node scripts/build-site.mjs [--out site] [--check 只对账不写]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadCatalog } from "./market.mjs";

const root = process.env.WFP_ROOT ? path.resolve(process.env.WFP_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function buildSite(repoRoot = root, outDir = path.join(repoRoot, "site"), { write = true } = {}) {
  const catalog = loadCatalog(repoRoot);
  const entries = [...catalog.entries].sort((a, b) => b.downloads - a.downloads || a.name.localeCompare(b.name));
  const api = {
    schema: 1,
    generatedAt: fs.statSync(path.join(repoRoot, "stats", "downloads.json")).mtime.toISOString().slice(0, 10),
    totalDownloads: entries.reduce((s, e) => s + e.downloads, 0),
    plugins: entries.map((e) => ({
      name: e.name,
      version: e.version,
      description: e.description,
      category: e.category,
      downloads: e.downloads,
      integrity: e.integrity ?? null,
      bundled: Boolean(e["bundled-in-kaleidosphere"]),
    })),
  };
  const files = {
    "api/market.json": JSON.stringify(api, null, 2) + "\n",
    "index.html": renderPage(api),
  };
  if (write) {
    for (const [rel, content] of Object.entries(files)) {
      const dest = path.join(outDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, content);
    }
  }
  return { api, files };
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderPage(api) {
  const cards = api.plugins.map((p) => `      <article class="card" data-search="${esc((p.name + " " + p.description + " " + p.category).toLowerCase())}" data-category="${p.category}">
        <header><h2>${esc(p.name)}</h2><span class="ver">${esc(p.version)}</span></header>
        <p class="desc">${esc(p.description)}</p>
        <footer>
          <span class="tag">${esc(p.category)}</span>
          <span class="tag muted" data-bundled="${p.bundled}">${p.bundled ? "bundled" : "standalone"}</span>
          <span class="dl" title="downloads">↓ ${p.downloads}</span>
        </footer>
      </article>`).join("\n");
  // 注意：<script> 内容不做 HTML 实体转义（script 是 raw text，实体不解码）；
  // 防注入用 \u003c 转义 "<"，JSON 合法且 </script> 序列不可能出现。
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>workflow-party · 插件市场</title>
<meta name="description" content="${esc("cctice 的个人代理工作流插件市场：市场索引、下载台账与验证产物一站浏览。")}">
<style>
  :root { --ink:#1d1d1f; --sub:#6e6e73; --bg:#f5f5f7; --card:#ffffff; --line:#e5e5ea; --accent:#0a84ff; }
  @media (prefers-color-scheme: dark) {
    :root { --ink:#f5f5f7; --sub:#a1a1a6; --bg:#000; --card:#1c1c1e; --line:#2c2c2e; --accent:#0a84ff; }
  }
  * { box-sizing: border-box; margin: 0; }
  body { font: -apple-system, "SF Pro Text", "PingFang SC", system-ui, sans-serif; background: var(--bg); color: var(--ink); }
  main { max-width: 860px; margin: 0 auto; padding: 48px 24px 72px; }
  h1 { font-size: 28px; font-weight: 700; letter-spacing: -0.02em; }
  .lede { color: var(--sub); margin: 8px 0 28px; font-size: 15px; }
  .lede a { color: var(--accent); text-decoration: none; }
  .controls { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 24px; }
  .controls input, .controls select { font: inherit; font-size: 15px; padding: 9px 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--card); color: var(--ink); min-width: 0; }
  .controls input[type="search"] { flex: 1 1 240px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 14px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 18px 18px 14px; display: flex; flex-direction: column; gap: 10px; }
  .card header { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  .card h2 { font-size: 17px; font-weight: 650; letter-spacing: -0.01em; }
  .ver { color: var(--sub); font-size: 13px; font-variant-numeric: tabular-nums; }
  .desc { color: var(--sub); font-size: 13.5px; line-height: 1.5; flex: 1; }
  .card footer { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .tag { font-size: 11.5px; padding: 3px 8px; border-radius: 999px; background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--accent); }
  .tag.muted { background: var(--bg); color: var(--sub); }
  .dl { margin-left: auto; color: var(--sub); font-size: 12.5px; font-variant-numeric: tabular-nums; }
  .empty { color: var(--sub); padding: 40px 0; text-align: center; display: none; }
  footer.site { color: var(--sub); font-size: 12.5px; margin-top: 40px; }
</style>
</head>
<body>
<main>
  <h1>workflow-party 插件市场</h1>
  <p class="lede">${api.plugins.length} 个插件 · 累计下载 ${api.totalDownloads} · 数据快照 ${esc(api.generatedAt)} · API：<a href="api/market.json">api/market.json</a></p>
  <div class="controls">
    <input id="q" type="search" placeholder="搜索插件、描述或分类…" aria-label="搜索插件">
    <select id="cat" aria-label="按分类过滤"><option value="">全部分类</option></select>
  </div>
  <section class="cards" id="cards">
${cards}
  </section>
  <p class="empty" id="empty">没有匹配的插件。</p>
  <footer class="site">由 <code>scripts/build-site.mjs</code> 生成（site-gate 漂移门看守，手改即红）· 指纹与产物对账见 <code>npm run verify:artifacts</code></footer>
</main>
<script id="market-data" type="application/json">${JSON.stringify({ categories: [...new Set(api.plugins.map((p) => p.category))] }).replace(/</g, "\\u003c")}</script>
<script>
  const data = JSON.parse(document.getElementById("market-data").textContent);
  const catSel = document.getElementById("cat");
  for (const c of data.categories) catSel.add(new Option(c, c));
  const cards = [...document.querySelectorAll(".card")];
  const apply = () => {
    const q = document.getElementById("q").value.trim().toLowerCase();
    const cat = catSel.value;
    let shown = 0;
    for (const el of cards) {
      const hit = (!q || el.dataset.search.includes(q)) && (!cat || el.dataset.category === cat);
      el.style.display = hit ? "" : "none";
      if (hit) shown++;
    }
    document.getElementById("empty").style.display = shown ? "none" : "block";
  };
  document.getElementById("q").addEventListener("input", apply);
  catSel.addEventListener("change", apply);
</script>
</body>
</html>
`;
}

// ---- CLI ----
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const outDir = outIdx >= 0 ? path.resolve(args[outIdx + 1]) : path.join(root, "site");
  const { api, files } = buildSite(root, outDir);
  if (args.includes("--check")) {
    // 只对账不写已在上面写了？——check 模式应为只读比较：对已落盘文件逐字节比
    let drift = false;
    for (const [rel, content] of Object.entries(files)) {
      const onDisk = fs.readFileSync(path.join(outDir, rel), "utf8");
      if (onDisk !== content) { console.error(`✗ 站点已过期：${rel} 与市场真源不符（重跑 build-site 刷新）`); drift = true; }
    }
    if (drift) process.exit(1);
    console.log(`✓ 静态站点与市场真源一致：${api.plugins.length} 条目`);
  } else {
    console.log(`站点已生成：${outDir}（index.html + api/market.json，${api.plugins.length} 条目）`);
  }
}
