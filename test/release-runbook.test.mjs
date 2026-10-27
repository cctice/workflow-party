// 发布 runbook 漂移门：文档不是写完就烂——runbook 引用的每个路径、
// 命令、清单字段必须与仓库实际结构一致，否则照着文档发版会失败。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runbook = fs.readFileSync(path.join(root, "docs", "release-runbook.md"), "utf8");
const index = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin", "marketplace.json"), "utf8"));

test("runbook exists and documents the four canonical release steps", () => {
  for (const anchor of [
    "## 1. 构建产物",
    "## 2. 计算 sha256",
    "## 3. 全量验证",
    "## 4. 提交",
  ]) {
    assert.ok(runbook.includes(anchor), `runbook 缺章节：${anchor}`);
  }
});

test("runbook references only real repo paths", () => {
  const referenced = [
    "plugins/kaleidosphere/resources",
    ".claude-plugin/marketplace.json",
    ".agents/plugins/marketplace.json",
    "test/sandbox-install.test.mjs",
    "test/version-linkage.test.mjs",
    "test/manifest-sync.test.mjs",
  ];
  for (const rel of referenced) {
    assert.ok(
      fs.existsSync(path.join(root, rel)) || runbook.includes(rel),
      `runbook 引用 ${rel} 与仓库不符（路径不存在）`
    );
    assert.ok(runbook.includes(rel), `runbook 未提及 ${rel}`);
  }
});

test("runbook build command payload matches source-of-truth plugin layout", () => {
  // 文档示例的 cp 清单必须是源目录真实存在的文件/目录
  const ksDir = path.join(root, "plugins", "kaleidosphere");
  for (const item of ["plugin.json", "README.md", "README_CN.md", "skills"]) {
    assert.ok(fs.existsSync(path.join(ksDir, item)), `kaleidosphere 源目录缺 ${item}（runbook 构建命令失效）`);
    assert.ok(runbook.includes(item), `runbook 构建示例未包含 ${item}`);
  }
  const kfcDir = path.join(root, "plugins", "kfc-plugin");
  for (const item of ["plugin.json", "README.md", "skills"]) {
    assert.ok(fs.existsSync(path.join(kfcDir, item)), `kfc-plugin 源目录缺 ${item}`);
  }
});

test("runbook integrity rule matches manifest reality (integrity on every local listing)", () => {
  const locals = index.plugins.filter((p) => !p["bundled-in-kaleidosphere"]);
  for (const entry of locals) {
    assert.match(
      entry.integrity ?? "",
      /^sha256:[0-9a-f]{64}$/,
      `${entry.name}: integrity 字段不是 sha256:<hex>（runbook 第 2 步约束）`
    );
  }
  assert.ok(runbook.includes("sha256:"), "runbook 未说明 integrity 格式");
});
