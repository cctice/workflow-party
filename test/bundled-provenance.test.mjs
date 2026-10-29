// bundled 形态完整性声明测试（维护心跳包·九轮）：afk bundled-in-kaleidosphere 此前无独立
// 产物与指纹——消费者只能装 kaleidosphere 顺带、完整性零声明。现台账 form:"bundled" 声明
// （bundledIn 载体/bundledPath 源目录/sha256-tree 树指纹），verify 源仓在场即现算复验。
//   ① 台账声明齐备：afk 有 form/bundledIn/树指纹/bundledPath，bundledIn 指向在列插件版本
//   ② 树指纹稳定可复算（同目录两次同值）；篡改一文件即变（拦截力）
//   ③ 源仓在场复验：verifyAllDetailed 真实根 issues=[]；ks 兄弟仓不在场 → 如实 skipped（不造假绿）
//   ④ 载体目录漂移 → 红（WFP_BUNDLED_SOURCE 注入被篡改副本，实证拦截）
//   ⑤ bundled 条目缺声明 → 红（fixture 根删台账记录）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { treeHashDir, verifyAllDetailed, verifyAll } from "../scripts/verify-artifacts.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const index = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin", "marketplace.json"), "utf8"));
const provenance = JSON.parse(fs.readFileSync(path.join(root, "provenance.json"), "utf8"));
const afk = index.plugins.find((p) => p.name === "afk");
const afkProv = provenance.artifacts.find((a) => a.plugin === "afk");

const ksSibling = path.resolve(root, "..", "..", "ks-fork-proj", "kaleidosphere");
const afkSourceDir = path.join(ksSibling, "plugins", "afk");

function copyRepoFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wfp-bundled-"));
  for (const rel of [".claude-plugin/marketplace.json", ".agents/plugins/marketplace.json", "provenance.json"]) {
    const dest = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(root, rel), dest);
  }
  return tmp;
}

test("台账声明齐备：form/bundledIn/树指纹/bundledPath 一个不少，载体指向在列插件", () => {
  assert.ok(afk && afk["bundled-in-kaleidosphere"], "前置：afk 是 bundled 条目");
  assert.equal(afkProv.form, "bundled");
  assert.match(afkProv.sha256, /^sha256-tree:[0-9a-f]{64}$/);
  assert.ok(afkProv.bundledPath);
  const [carrierName, carrierVersion] = afkProv.bundledIn.split("@");
  const carrier = index.plugins.find((p) => p.name === carrierName && p.version === carrierVersion);
  assert.ok(carrier, `载体 ${afkProv.bundledIn} 必须是市场在列插件`);
});

test("树指纹稳定可复算；篡改一文件即变（拦截力）", { skip: !fs.existsSync(afkSourceDir) && "ks 兄弟仓不在场，跳过" }, () => {
  const h1 = treeHashDir(afkSourceDir);
  assert.equal(h1, afkProv.sha256, "台账树指纹必须与源仓现算一致（漂移即红）");
  assert.equal(treeHashDir(afkSourceDir), h1, "同目录两次计算同值");
  const tampered = fs.mkdtempSync(path.join(os.tmpdir(), "wfp-bundled-tamper-"));
  fs.cpSync(afkSourceDir, tampered, { recursive: true });
  fs.appendFileSync(path.join(tampered, "plugin.json"), "\n");
  assert.notEqual(treeHashDir(tampered), h1, "内容一变指纹必变");
  fs.rmSync(tampered, { recursive: true, force: true });
});

test("源仓在场复验：真实根 issues=[]；不在场如实 skipped 不造假绿", { skip: !fs.existsSync(afkSourceDir) && "ks 兄弟仓不在场，跳过" }, () => {
  const ok = verifyAllDetailed(root);
  assert.deepEqual(ok.issues, []);
  // 源仓指向不存在的路径：声明仍在账，复验如实跳过
  const prev = process.env.WFP_BUNDLED_SOURCE;
  process.env.WFP_BUNDLED_SOURCE = path.join(os.tmpdir(), "wfp-no-such-source");
  try {
    const skippedRun = verifyAllDetailed(root);
    assert.deepEqual(skippedRun.issues, []);
    assert.ok(skippedRun.skipped.some((s) => s.startsWith("afk@")), "afk 复验跳过要如实点名");
  } finally {
    if (prev === undefined) delete process.env.WFP_BUNDLED_SOURCE;
    else process.env.WFP_BUNDLED_SOURCE = prev;
  }
});

test("载体目录漂移 → 红（注入被篡改源仓，实证拦截）", { skip: !fs.existsSync(afkSourceDir) && "ks 兄弟仓不在场，跳过" }, () => {
  const tmp = copyRepoFixture();
  const tamperedSource = fs.mkdtempSync(path.join(os.tmpdir(), "wfp-bundled-src-"));
  fs.cpSync(path.join(ksSibling, "plugins"), path.join(tamperedSource, "plugins"), { recursive: true });
  fs.appendFileSync(path.join(tamperedSource, "plugins", "afk", "plugin.json"), "\n");
  const prev = process.env.WFP_BUNDLED_SOURCE;
  process.env.WFP_BUNDLED_SOURCE = tamperedSource;
  try {
    const issues = verifyAll(tmp);
    assert.ok(issues.some((i) => i.startsWith("afk@") && i.includes("树指纹")), `应红：${issues.join("；")}`);
  } finally {
    if (prev === undefined) delete process.env.WFP_BUNDLED_SOURCE;
    else process.env.WFP_BUNDLED_SOURCE = prev;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(tamperedSource, { recursive: true, force: true });
});

test("bundled 条目缺声明 → 红（fixture 根删台账记录）", () => {
  const tmp = copyRepoFixture();
  const prov = JSON.parse(fs.readFileSync(path.join(tmp, "provenance.json"), "utf8"));
  prov.artifacts = prov.artifacts.filter((a) => a.plugin !== "afk");
  fs.writeFileSync(path.join(tmp, "provenance.json"), JSON.stringify(prov, null, 2));
  const issues = verifyAll(tmp);
  assert.ok(issues.some((i) => i.startsWith("afk@") && i.includes("无台账声明")), `应红：${issues.join("；")}`);
  fs.rmSync(tmp, { recursive: true, force: true });
});
