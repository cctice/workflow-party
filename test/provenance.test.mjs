// 产物信任链台账测试（维护心跳包·五轮）：指纹机制是补出来的，历史产物缺"来源记录"——
// provenance.json 台账补录来源锚点，本测试看守三方对账契约不漂。
//   ① 每个本地产物必有台账记录（新发布忘登记 → 红）
//   ② 台账指纹 = 清单 integrity = 实文件现算 sha256（三方一线）
//   ③ 产物文件名 = 插件名-版本.tgz（防挂羊头）
//   ④ 台账记录必带来源字段（sourceRepo/builtFrom/recordedAt，来源可追溯是台账的存在意义）
//   ⑤ 台账无死记录（清单没有的条目不许留）
//   ⑥ verifyAll 对账函数：干净根全绿；篡改指纹/删产物/塞死记录 → 逐条红（自证拦截力）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyAll } from "../scripts/verify-artifacts.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const index = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin", "marketplace.json"), "utf8"));
const provenance = JSON.parse(fs.readFileSync(path.join(root, "provenance.json"), "utf8"));
const localEntries = index.plugins.filter((p) => !p["bundled-in-kaleidosphere"]);
const ledger = new Map(provenance.artifacts.map((a) => [`${a.plugin}@${a.version}`, a]));

test("台账覆盖：每个本地产物条目都有来源记录", () => {
  for (const entry of localEntries) {
    assert.ok(ledger.has(`${entry.name}@${entry.version}`), `${entry.name}@${entry.version} 台账缺记录`);
  }
});

test("台账指纹与市场清单 integrity 一致", () => {
  for (const entry of localEntries) {
    const prov = ledger.get(`${entry.name}@${entry.version}`);
    assert.equal(prov.sha256, entry.integrity, `${entry.name} 台账≠清单`);
  }
});

test("台账来源字段齐备（sourceRepo/builtFrom/recordedAt 一个不能少）", () => {
  for (const prov of provenance.artifacts) {
    assert.ok(prov.sourceRepo, `${prov.plugin} 缺 sourceRepo`);
    assert.ok(prov.builtFrom, `${prov.plugin} 缺 builtFrom`);
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(prov.recordedAt), `${prov.plugin} recordedAt 非日期`);
  }
});

test("台账无死记录：登记的条目市场清单里都存在", () => {
  const listed = new Set(localEntries.map((p) => `${p.name}@${p.version}`));
  for (const key of ledger.keys()) {
    assert.ok(listed.has(key), `${key} 是台账死记录`);
  }
});

test("verifyAll：真实仓库根对账全绿", () => {
  assert.deepEqual(verifyAll(root), []);
});

test("verifyAll：篡改指纹 → 红（自证拦截力）", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wfp-prov-"));
  const copy = (rel) => {
    const dest = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(root, rel), dest);
  };
  copy(".claude-plugin/marketplace.json");
  copy(".agents/plugins/marketplace.json");
  const provPath = path.join(tmp, "provenance.json");
  fs.copyFileSync(path.join(root, "provenance.json"), provPath);
  const tampered = JSON.parse(fs.readFileSync(provPath, "utf8"));
  tampered.artifacts[0].sha256 = "sha256:" + "0".repeat(64);
  fs.writeFileSync(provPath, JSON.stringify(tampered, null, 2));
  const issues = verifyAll(tmp);
  assert.ok(issues.some((i) => i.includes("指纹")), `应抓到指纹篡改，实际：${issues}`);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("verifyAll：登记了不存在的产物 → 红", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wfp-prov-"));
  const copy = (rel) => {
    const dest = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(root, rel), dest);
  };
  copy(".claude-plugin/marketplace.json");
  copy(".agents/plugins/marketplace.json");
  const provPath = path.join(tmp, "provenance.json");
  const prov = { schema: 1, artifacts: [] };
  // 台账指向不存在的产物路径
  prov.artifacts = localEntries.map((e) => ({
    plugin: e.name, version: e.version, artifact: "no/such/file.tgz",
    sha256: e.integrity, sourceRepo: "x", builtFrom: "x", recordedAt: "2026-10-28",
  }));
  fs.writeFileSync(provPath, JSON.stringify(prov));
  const issues = verifyAll(tmp);
  assert.ok(issues.some((i) => i.includes("不存在")), `应抓到产物缺失，实际：${issues}`);
  fs.rmSync(tmp, { recursive: true, force: true });
});
