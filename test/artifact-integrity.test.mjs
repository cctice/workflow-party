// 产物完整性测试：把市场清单的“已验证产物（verified artifact）”从
// “文件存在”升级为“内容可验证”。
//
// 批评与自我批评发现的盲区：
// 1. 原测试只断言 tgz 存在——任何人替换产物内容（版本不符、塞私货）
//    测试依然全绿；清单里也没有任何指纹可对外承诺“验证过”。
// 2. 顶层 resources/ 与 plugins/kaleidosphere/resources/ 曾各存一份
//    相同 sha 的 tgz（重复产物 = 漂移温床），且 README 表格指向了
//    不存在的路径。
//
// 修复后契约：
// - 市场索引每个本地产物条目带 integrity: "sha256:<hex>"，测试现算现比；
// - 用纯 Node（zlib + 512 字节 ustar 头解析，零依赖）解开 tgz，
//   断言其中的 plugin.json / package.json 的 name+version 与清单一致；
// - 仓库顶层不允许再出现游离的 resources/ 产物目录。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const index = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin", "marketplace.json"), "utf8"));
const localListings = index.plugins.filter((p) => !p["bundled-in-kaleidosphere"]);

const sha256 = (buf) => `sha256:${crypto.createHash("sha256").update(buf).digest("hex")}`;

// 极简 tar 读取器：仅支持 ustar 常规文件（npm pack / tar czf 的产物足够），
// 避免为零依赖仓引入 tar 依赖或依赖系统 tar 命令。
function readTarEntries(gzBuffer) {
  const buf = zlib.gunzipSync(gzBuffer);
  const entries = new Map();
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break; // 结束块
    const rawName = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/s, "");
    const typeFlag = String.fromCharCode(header[156]);
    const size = parseInt(header.subarray(124, 136).toString("utf8").replace(/\0.*$/s, "").trim() || "0", 8);
    offset += 512;
    const data = buf.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    if (typeFlag === "0" || typeFlag === "\0") {
      const name = prefix ? `${prefix}/${rawName}` : rawName;
      entries.set(name, data);
    }
  }
  return entries;
}

const normalize = (name) => name.replace(/^\.\//, "").replace(/^package\//, "");

// tgz 根部（或 npm pack 的 package/ 根下）的清单文件
function findRootManifest(entries) {
  for (const [name, data] of entries) {
    const n = normalize(name);
    if (n === "plugin.json" || n === "package.json") return JSON.parse(data.toString("utf8"));
  }
  return null;
}

test("integrity: index entries carry sha256 fingerprints that match the artifacts on disk", () => {
  assert.ok(localListings.length >= 2, "expected the two local listings");
  for (const entry of localListings) {
    assert.match(entry.integrity ?? "", /^sha256:[0-9a-f]{64}$/, `${entry.name}: integrity field must be sha256:<hex>`);
    const tgz = path.join(root, "plugins", entry.name, "resources", `${entry.name}-${entry.version}.tgz`);
    const actual = sha256(fs.readFileSync(tgz));
    assert.equal(actual, entry.integrity, `${entry.name}: artifact on disk no longer matches its recorded fingerprint`);
  }
});

test("verified artifacts really contain the listed plugin: tar root manifest name+version match the listing", () => {
  for (const entry of localListings) {
    const tgz = path.join(root, "plugins", entry.name, "resources", `${entry.name}-${entry.version}.tgz`);
    const entries = readTarEntries(fs.readFileSync(tgz));
    const manifest = findRootManifest(entries);
    assert.ok(manifest, `${entry.name}: no plugin.json/package.json at the tarball root`);
    assert.equal(manifest.name, entry.name, `${entry.name}: tarball manifest name mismatch`);
    assert.equal(manifest.version, entry.version, `${entry.name}: tarball manifest version mismatch`);
  }
});

test("no stray top-level resources/: verified artifacts live only under plugins/<name>/resources/", () => {
  const stray = path.join(root, "resources");
  assert.equal(fs.existsSync(stray), false,
    "top-level resources/ duplicates plugins/<name>/resources/ artifacts and must not come back");
});

test("license claim is backed by package.json and a LICENSE file", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.license, "MIT");
  assert.equal(fs.existsSync(path.join(root, "LICENSE")), true);
  const license = fs.readFileSync(path.join(root, "LICENSE"), "utf8");
  assert.match(license, /^MIT License/);

  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  assert.match(readme, /license-MIT-3B82F6\)\]\(https:\/\/github\.com\/cctice\/workflow-party\/blob\/master\/LICENSE\)/,
    "license badge must link to the LICENSE file, not to package.json");
});
