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
