// 徽章自动刷测试（维护心跳包·十三轮）：tests 徽章静态口径 → 一条命令+对账门。
//   ① 真仓同步态：--check 过（徽章=用例计数）
//   ② 演练：徽章漂移后 sync --root tmp --no-run 刷回真源值
//   ③ --check 红态：徽章≠计数非零退出并指路 sync
//   ④ 红不刷：必红测试在场时 sync 拒刷（不粉饰）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SYNC = path.join(root, "scripts", "sync-badges.mjs");

test("--check 通过路径：sync 刷齐后对账过（真仓同步态由 manifest-sync 徽章门看守，不重复依赖顺序）", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wfp-badge-"));
  fs.mkdirSync(path.join(tmp, "test"), { recursive: true });
  fs.cpSync(path.join(root, "test"), path.join(tmp, "test"), { recursive: true });
  for (const f of ["README.md", "README_CN.md"]) fs.copyFileSync(path.join(root, f), path.join(tmp, f));
  execFileSync(process.execPath, [SYNC, "--root", tmp, "--no-run"], { encoding: "utf8" }); // 刷齐
  const out = execFileSync(process.execPath, [SYNC, "--check", "--root", tmp], { encoding: "utf8" });
  assert.match(out, /徽章 \d+ passing 与用例计数一致/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("演练：徽章漂移，sync --no-run 刷回真源（双语同值）", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wfp-badge-"));
  fs.mkdirSync(path.join(tmp, "test"), { recursive: true });
  fs.cpSync(path.join(root, "test"), path.join(tmp, "test"), { recursive: true });
  for (const f of ["README.md", "README_CN.md"]) {
    fs.writeFileSync(path.join(tmp, f), fs.readFileSync(path.join(root, f), "utf8").replace(/badge\/tests-\d+%20passing-/, "badge/tests-999%20passing-"));
  }
  const out = execFileSync(process.execPath, [SYNC, "--root", tmp, "--no-run"], { encoding: "utf8" });
  assert.match(out, /999 → \d+ passing/);
  const badge = (f) => fs.readFileSync(path.join(tmp, f), "utf8").match(/badge\/tests-(\d+)%20passing-/)[1];
  assert.equal(badge("README.md"), badge("README_CN.md"), "双语同刷同值");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("--check 红态：徽章≠计数非零退出并指路", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wfp-badge-"));
  fs.mkdirSync(path.join(tmp, "test"), { recursive: true });
  fs.cpSync(path.join(root, "test"), path.join(tmp, "test"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "README.md"), fs.readFileSync(path.join(root, "README.md"), "utf8").replace(/badge\/tests-\d+%20passing-/, "badge/tests-999%20passing-"));
  fs.writeFileSync(path.join(tmp, "README_CN.md"), fs.readFileSync(path.join(root, "README_CN.md"), "utf8").replace(/badge\/tests-\d+%20passing-/, "badge/tests-999%20passing-"));
  const r = spawnSync(process.execPath, [SYNC, "--check", "--root", tmp], { encoding: "utf8" });
  assert.notEqual(r.status, 0, "红态非零退出");
  assert.match(r.stderr, /999.*≠.*\d+.*sync:badges/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("红不刷：必红测试在场，sync 拒刷徽章（不粉饰）", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wfp-badge-"));
  fs.mkdirSync(path.join(tmp, "test"), { recursive: true });
  fs.cpSync(path.join(root, "test"), path.join(tmp, "test"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "test", "zz-red.test.mjs"), 'import { test } from "node:test";\ntest("必红", () => { throw new Error("boom"); });\n');
  for (const f of ["README.md", "README_CN.md"]) {
    fs.writeFileSync(path.join(tmp, f), fs.readFileSync(path.join(root, f), "utf8").replace(/badge\/tests-\d+%20passing-/, "badge/tests-999%20passing-"));
  }
  const r = spawnSync(process.execPath, [SYNC, "--root", tmp], { encoding: "utf8" });
  assert.notEqual(r.status, 0, "红态非零退出");
  assert.match(r.stderr, /测试未全绿.*徽章不刷/);
  assert.match(fs.readFileSync(path.join(tmp, "README.md"), "utf8"), /tests-999%20passing-/, "徽章原样未动");
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── site 静态面同源（十四轮）：site/api/market.json 的 tests 数与徽章同一真相源 ──
// 痛点（十三轮留题）：site 静态面若内嵌 tests 数，就是徽章数据的第二真相源——
// sync-badges 刷了 README 不刷站点即漂。现在 declaredTests 收口 market.mjs 单一
// 真源，sync 刷徽章顺带重建站点，--check 对账两面一起看。
test("真仓同步态：site api tests == 用例计数（与徽章同源）", () => {
  const api = JSON.parse(fs.readFileSync(path.join(root, "site", "api", "market.json"), "utf8"));
  const testFiles = fs.readdirSync(path.join(root, "test")).filter((f) => f.endsWith(".test.mjs"));
  let declared = 0;
  for (const file of testFiles) {
    declared += (fs.readFileSync(path.join(root, "test", file), "utf8").match(/^test\(/gm) || []).length;
  }
  assert.equal(api.tests, declared, "site api tests 与静态声明计数一致（漂了跑 npm run sync:badges）");
});

test("演练：site api tests 漂移，sync --no-run 重建站点修回；--check 红态点名 site", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wfp-badge-site-"));
  fs.mkdirSync(path.join(tmp, "test"), { recursive: true });
  fs.cpSync(path.join(root, "test"), path.join(tmp, "test"), { recursive: true });
  for (const f of ["README.md", "README_CN.md"]) fs.copyFileSync(path.join(root, f), path.join(tmp, f));
  fs.mkdirSync(path.join(tmp, "site", "api"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "stats"), { recursive: true });
  fs.mkdirSync(path.join(tmp, ".claude-plugin"), { recursive: true }); // buildSite 依赖（catalog+downloads 真源）
  fs.copyFileSync(path.join(root, "stats", "downloads.json"), path.join(tmp, "stats", "downloads.json"));
  fs.copyFileSync(path.join(root, ".claude-plugin", "marketplace.json"), path.join(tmp, ".claude-plugin", "marketplace.json"));
  const api = JSON.parse(fs.readFileSync(path.join(root, "site", "api", "market.json"), "utf8"));
  api.tests = 999; // 人肉手改站点的典型漂移
  fs.writeFileSync(path.join(tmp, "site", "api", "market.json"), JSON.stringify(api, null, 2) + "\n");
  const red = spawnSync(process.execPath, [SYNC, "--check", "--root", tmp], { encoding: "utf8" });
  assert.notEqual(red.status, 0, "site 漂移 --check 红");
  assert.match(red.stderr, /site api tests（999）亦漂/, "红态点名 site 面");
  execFileSync(process.execPath, [SYNC, "--root", tmp, "--no-run"], { encoding: "utf8" });
  const fixed = JSON.parse(fs.readFileSync(path.join(tmp, "site", "api", "market.json"), "utf8"));
  const testFiles = fs.readdirSync(path.join(tmp, "test")).filter((f) => f.endsWith(".test.mjs"));
  let declared = 0;
  for (const file of testFiles) declared += (fs.readFileSync(path.join(tmp, "test", file), "utf8").match(/^test\(/gm) || []).length;
  assert.equal(fixed.tests, declared, "sync 重建站点后同源一致");
  const green = execFileSync(process.execPath, [SYNC, "--check", "--root", tmp], { encoding: "utf8" });
  assert.match(green, /site api 同源一致/);
  fs.rmSync(tmp, { recursive: true, force: true });
});
