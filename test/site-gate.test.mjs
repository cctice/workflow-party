// 静态站点门（维护心跳包·九轮）：CLI 之外的消费面——网页浏览/宿主内嵌。
//   ① API 面：site/api/market.json 条目集合/版本/下载量与市场真源一一对应
//   ② 页面：index.html 含每个插件名与版本、API 链接、零依赖可离线（数据内嵌，file:// 同形）
//   ③ 确定性：同输入两次构建字节一致（确定性生成，可进版本库）
//   ④ 漂移门：committed 站点与市场真源不符（改了市场忘重建）→ 红
//   ⑤ CLI 冒烟：build-site --check 真实进程跑通
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildSite } from "../scripts/build-site.mjs";
import { loadCatalog } from "../scripts/market.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalog = loadCatalog(root);

test("API 面：条目集合/下载量与市场真源一一对应", () => {
  const api = JSON.parse(fs.readFileSync(path.join(root, "site", "api", "market.json"), "utf8"));
  assert.equal(api.plugins.length, catalog.entries.length);
  for (const p of api.plugins) {
    const src = catalog.entries.find((e) => e.name === p.name);
    assert.ok(src, `${p.name} 不在市场真源`);
    assert.equal(p.version, src.version);
    assert.equal(p.downloads, src.downloads);
    assert.equal(p.bundled, Boolean(src["bundled-in-kaleidosphere"]));
    assert.equal(p.integrity ?? null, src.integrity ?? null);
  }
});

test("页面：每插件在列 + API 链接 + 数据内嵌（file:// 离线同形）", () => {
  const html = fs.readFileSync(path.join(root, "site", "index.html"), "utf8");
  for (const e of catalog.entries) {
    assert.ok(html.includes(e.name), `${e.name} 缺席页面`);
    assert.ok(html.includes(e.version), `${e.name}@${e.version} 版本缺席`);
  }
  assert.ok(html.includes("api/market.json"), "API 链接缺席");
  assert.match(html, /<script id="market-data" type="application\/json">/, "数据必须内嵌（file:// 下 fetch 不可用）");
  assert.ok(!html.includes("http://") && !/<script src=/.test(html), "零外部依赖（无外链脚本/资源）");
});

test("确定性：同输入两次构建字节一致", () => {
  const out1 = fs.mkdtempSync(path.join(os.tmpdir(), "wfp-site-1-"));
  const out2 = fs.mkdtempSync(path.join(os.tmpdir(), "wfp-site-2-"));
  buildSite(root, out1);
  buildSite(root, out2);
  for (const rel of ["index.html", "api/market.json"]) {
    assert.equal(
      fs.readFileSync(path.join(out1, rel), "utf8"),
      fs.readFileSync(path.join(out2, rel), "utf8"),
      `${rel} 构建不确定`
    );
  }
  fs.rmSync(out1, { recursive: true, force: true });
  fs.rmSync(out2, { recursive: true, force: true });
});

test("漂移门：committed 站点与真源不符 → 红（改市场忘重建即挂）", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wfp-site-drift-"));
  fs.mkdirSync(path.join(tmp, ".claude-plugin"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "stats"), { recursive: true });
  fs.cpSync(path.join(root, ".claude-plugin", "marketplace.json"), path.join(tmp, ".claude-plugin", "marketplace.json"));
  fs.cpSync(path.join(root, "stats", "downloads.json"), path.join(tmp, "stats", "downloads.json"));
  const out = path.join(tmp, "site");
  buildSite(tmp, out); // 以临时根为真源先建一份
  // 真源变：bump 下载量后不重建 → check 必须红
  const stats = JSON.parse(fs.readFileSync(path.join(tmp, "stats", "downloads.json"), "utf8"));
  stats.counts["kfc-plugin@0.1.1"] = 99;
  fs.writeFileSync(path.join(tmp, "stats", "downloads.json"), JSON.stringify(stats, null, 2) + "\n");
  const { files } = buildSite(tmp, out, { write: false });
  assert.notEqual(fs.readFileSync(path.join(out, "api", "market.json"), "utf8"), files["api/market.json"], "下载量变了站点必须过期");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("CLI 冒烟：build-site --check 真实进程跑通", () => {
  const out = execFileSync(process.execPath, [path.join(root, "scripts", "build-site.mjs"), "--check"], { encoding: "utf8" });
  assert.match(out, /静态站点与市场真源一致/);
});

// 十九轮补：--check 曾是空门+写盘双坏（buildSite 默认 write:true，先写再自比永不红、
// 工作树被摸脏）。两条真行为钉死：只读（漂了不自动修）+ 漂移真红（exit 1）。
test("CLI --check 真·只读：站点漂移时不自动重写（漂了就该红给人看，不悄悄修）", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wfp-site-ro-"));
  fs.mkdirSync(path.join(tmp, ".claude-plugin"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "stats"), { recursive: true });
  fs.cpSync(path.join(root, ".claude-plugin", "marketplace.json"), path.join(tmp, ".claude-plugin", "marketplace.json"));
  fs.cpSync(path.join(root, "stats", "downloads.json"), path.join(tmp, "stats", "downloads.json"));
  const out = path.join(tmp, "site");
  buildSite(tmp, out); // 先建一份与真源一致的
  const tampered = "手改即红探针\n";
  fs.writeFileSync(path.join(out, "index.html"), tampered); // 模拟 committed 站点被手改/过期
  let failed = false;
  try {
    execFileSync(process.execPath, [path.join(root, "scripts", "build-site.mjs"), "--check", "--out", out], {
      encoding: "utf8",
      env: { ...process.env, WFP_ROOT: tmp },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    failed = true;
    assert.match(String(e.stderr), /站点已过期/, "漂移必须点名而非静默");
  }
  assert.ok(failed, "站点漂移 --check 必须 exit 1");
  assert.equal(fs.readFileSync(path.join(out, "index.html"), "utf8"), tampered, "--check 不得自动重写（只读对账）");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("确定性·内容源：downloads.json 仅 mtime 变（内容不变）→ 产物字节不变", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wfp-site-mtime-"));
  fs.mkdirSync(path.join(tmp, ".claude-plugin"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "stats"), { recursive: true });
  fs.cpSync(path.join(root, ".claude-plugin", "marketplace.json"), path.join(tmp, ".claude-plugin", "marketplace.json"));
  fs.cpSync(path.join(root, "stats", "downloads.json"), path.join(tmp, "stats", "downloads.json"));
  const out = path.join(tmp, "site");
  buildSite(tmp, out);
  const before = fs.readFileSync(path.join(out, "api", "market.json"), "utf8");
  const { utimesSync } = fs;
  const old = new Date("2020-01-01T00:00:00Z");
  utimesSync(path.join(tmp, "stats", "downloads.json"), old, old); // 只摸 mtime，内容分毫不动
  const { files } = buildSite(tmp, out, { write: false });
  assert.equal(files["api/market.json"], before, "generatedAt 必须内容源（updatedAt），mtime 漂移不进产物");
  fs.rmSync(tmp, { recursive: true, force: true });
});
