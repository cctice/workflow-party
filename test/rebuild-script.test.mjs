// 重建脚本形态门：scripts/rebuild-artifacts.mjs 把 runbook 第 1-2-5 步收进一条
// 命令——脚本一旦漂（staging 载荷缺项、.DS_Store 带进产物、清单/台账漏回写），
// 发布链就退回人肉。本文件两段验证：
//   A) 临时仓夹具：rebuildPlugin 全行为断言（产物名/指纹/双清单/台账/载荷）；
//   B) 真仓整仓演练：把仓库拷进临时目录跑 rebuildAll，三方对账必须全绿
//      （证明"下一次发版直接跑脚本"不是推断）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { rebuildPlugin, rebuildAll } from "../scripts/rebuild-artifacts.mjs";
import { verifyAll } from "../scripts/verify-artifacts.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 临时仓夹具：一个最小可发版市场（源目录+双清单+空台账） */
function makeFixtureRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "wfp-rebuild-test-"));
  const src = path.join(repo, "plugins", "demo");
  fs.mkdirSync(path.join(src, "skills", "demo-skill"), { recursive: true });
  fs.mkdirSync(path.join(src, "resources"), { recursive: true });
  fs.writeFileSync(
    path.join(src, "plugin.json"),
    JSON.stringify({ name: "demo", version: "9.9.9", description: "demo", category: "developer-tools" })
  );
  fs.writeFileSync(path.join(src, "README.md"), "# demo\n");
  fs.writeFileSync(path.join(src, "skills", "demo-skill", "SKILL.md"), "---\nname: demo-skill\n---\nbody\n");
  fs.writeFileSync(path.join(src, ".DS_Store"), "junk"); // 必须被清出产物
  fs.mkdirSync(path.join(repo, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      name: "fixture",
      plugins: [{ name: "demo", version: "0.0.1", source: "./plugins/demo", category: "developer-tools", integrity: "sha256:" + "0".repeat(64) }],
    })
  );
  fs.mkdirSync(path.join(repo, ".agents", "plugins"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, ".agents", "plugins", "marketplace.json"),
    JSON.stringify({
      plugins: [{ name: "demo", version: "0.0.1", source: { source: "local", path: "./plugins/demo" }, category: "Developer Tools" }],
    })
  );
  return repo;
}

/** tgz 文件名集合（package/ 根形态） */
function tarNames(tgzPath) {
  const buf = zlib.gunzipSync(fs.readFileSync(tgzPath));
  const names = [];
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const raw = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(header.subarray(124, 136).toString("utf8").replace(/\0.*$/s, "").trim() || "0", 8);
    offset += 512;
    const typeFlag = String.fromCharCode(header[156]);
    if (typeFlag === "0" || typeFlag === "\0") names.push(raw);
    offset += Math.ceil(size / 512) * 512;
  }
  return names;
}

test("rebuildPlugin: 产物名/指纹/双清单回写/provenance 登记/载荷契约一次全对", () => {
  const repo = makeFixtureRepo();
  const r = rebuildPlugin(repo, "demo");

  assert.equal(r.version, "9.9.9", "版本真源=源 plugin.json");
  assert.equal(r.artifact, "plugins/demo/resources/demo-9.9.9.tgz");
  assert.match(r.sha256, /^sha256:[0-9a-f]{64}$/);
  assert.ok(r.payload.includes("plugin.json") && r.payload.includes("README.md") && r.payload.includes("skills"));

  // 产物实文件指纹 = 回写值
  const actual = "sha256:" + crypto.createHash("sha256").update(fs.readFileSync(path.join(repo, r.artifact))).digest("hex");
  assert.equal(actual, r.sha256);

  // 双清单回写
  const index = JSON.parse(fs.readFileSync(path.join(repo, ".claude-plugin", "marketplace.json"), "utf8"));
  assert.equal(index.plugins[0].version, "9.9.9");
  assert.equal(index.plugins[0].integrity, r.sha256);
  const agents = JSON.parse(fs.readFileSync(path.join(repo, ".agents", "plugins", "marketplace.json"), "utf8"));
  assert.equal(agents.plugins[0].version, "9.9.9", "agents 版清单版本同步");

  // provenance 自动登记（登记不再靠人）
  const prov = JSON.parse(fs.readFileSync(path.join(repo, "provenance.json"), "utf8"));
  assert.equal(prov.artifacts.length, 1);
  assert.equal(prov.artifacts[0].plugin, "demo");
  assert.equal(prov.artifacts[0].sha256, r.sha256);
  assert.ok(prov.artifacts[0].rebuiltAt, "脚本化重建日期留档");

  // 产物内容：package/ 根形态 + .DS_Store 不在
  const names = tarNames(path.join(repo, r.artifact));
  assert.ok(names.includes("package/plugin.json"), "tgz 必须是 package/ 根形态（沙箱安装门契约）");
  assert.ok(names.some((n) => n.startsWith("package/skills/")), "skills 必须进产物");
  assert.ok(!names.some((n) => n.includes(".DS_Store")), ".DS_Store 必须被清出产物");
});

test("rebuildPlugin: 版本升档后旧台账记录让位（防死记录）", () => {
  const repo = makeFixtureRepo();
  rebuildPlugin(repo, "demo");
  // 升版本：改源真源
  const srcManifest = path.join(repo, "plugins", "demo", "plugin.json");
  const identity = JSON.parse(fs.readFileSync(srcManifest, "utf8"));
  identity.version = "10.0.0";
  fs.writeFileSync(srcManifest, JSON.stringify(identity));
  const r2 = rebuildPlugin(repo, "demo");

  const prov = JSON.parse(fs.readFileSync(path.join(repo, "provenance.json"), "utf8"));
  assert.equal(prov.artifacts.length, 1, "旧版本记录应让位（否则 verify 台账死记录红）");
  assert.equal(prov.artifacts[0].version, "10.0.0");
  assert.equal(r2.artifact, "plugins/demo/resources/demo-10.0.0.tgz");
});

test("rebuildPlugin: bundled 条目与身份错位如实拒绝", () => {
  const repo = makeFixtureRepo();
  const index = JSON.parse(fs.readFileSync(path.join(repo, ".claude-plugin", "marketplace.json"), "utf8"));
  index.plugins[0]["bundled-in-kaleidosphere"] = true;
  fs.writeFileSync(path.join(repo, ".claude-plugin", "marketplace.json"), JSON.stringify(index));
  assert.throws(() => rebuildPlugin(repo, "demo"), /bundled/);

  assert.throws(() => rebuildPlugin(repo, "no-such-plugin"), /plugin\.json 不存在/);
});

test("真仓整仓演练：临时副本跑 rebuildAll，三方对账全绿", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wfp-rebuild-e2e-"));
  fs.cpSync(root, tmp, { recursive: true, filter: (s) => !s.includes(".git/") });
  const { results, issues } = rebuildAll(tmp);
  assert.ok(results.length >= 2, "本仓至少 kaleidosphere+kfc-plugin 两个本地产物");
  assert.equal(issues.length, 0, `整仓重建后三方对账必须全绿，问题：${issues.join("；")}`);
  // 重建后指纹确实可能变（tar 时间戳），但清单/台账/实文件必须一致——verifyAll 已证；
  // 再证一遍：产物内 skills 布局仍在（沙箱安装门契约不因脚本化丢失）
  const ks = results.find((r) => r.name === "kaleidosphere");
  const names = tarNames(path.join(tmp, ks.artifact));
  assert.ok(names.some((n) => n.startsWith("package/skills/")));
});
