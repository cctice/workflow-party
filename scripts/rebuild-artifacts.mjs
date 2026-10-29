#!/usr/bin/env node
// rebuild-artifacts.mjs —— tgz 产物重建一键脚本化（维护心跳包·八轮）
//
// 背景：docs/release-runbook.md 第 1-2 步（mktemp staging → cp 源载荷 → tar czf
// → shasum → 手改双清单 integrity/version）此前全是人肉命令，五步分散、忘一步
// 就漂（版本三点一线门虽会拦，但"重建"本身仍靠人）。本脚本把
// 【staging → 打包 → 指纹 → 双清单回写 → provenance 台账登记】收进一条命令，
// 发布与重建从 runbook 人肉流程变脚本单入口，登记不再靠人。
//
// 用法：
//   node scripts/rebuild-artifacts.mjs --all          # 重建全部本地产物（bundled 条目跳过）
//   node scripts/rebuild-artifacts.mjs kaleidosphere  # 只重建指定插件
//
// 行为契约（与 runbook 逐条对齐，test/rebuild-script.test.mjs 看守形态）：
//   1. 版本真源=plugins/<name>/plugin.json（读它，不改它——升版本仍先改源）；
//   2. staging 载荷=plugin.json + README.md + README_CN.md + skills/（存在即收）；
//   3. 产物=plugins/<name>/resources/<name>-<version>.tgz（COPYFILE_DISABLE=1，
//      .DS_Store 清除，package/ 根目录形态——沙箱安装门的布局契约）；
//   4. sha256 回写 .claude-plugin/marketplace.json（version+integrity）与
//      .agents/plugins/marketplace.json（version 若有）；
//   5. provenance.json 自动登记/刷新（source/sourceRepo 保留既有溯源，
//      builtFrom 标注脚本化重建，忘登记这道人肉工序退役）；
//   6. 收尾自跑 scripts/verify-artifacts.mjs 三方对账，链不绿即非零退出。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyAll } from "./verify-artifacts.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** staging 载荷清单：runbook 契约——plugin.json 必带，文档与 skills 存在即收 */
const PAYLOAD = ["plugin.json", "README.md", "README_CN.md", "skills", "agents"];

const today = () => new Date().toISOString().slice(0, 10);
const sha256File = (p) => `sha256:${crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex")}`;

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
function writeJson(p, data) {
  fs.writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

/** 递归拷贝（保持目录形态），跳过 .DS_Store */
function copyPayload(srcDir, stageDir) {
  const copied = [];
  for (const item of PAYLOAD) {
    const src = path.join(srcDir, item);
    if (!fs.existsSync(src)) continue;
    fs.cpSync(src, path.join(stageDir, item), { recursive: true });
    copied.push(item);
  }
  const purge = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name === ".DS_Store") {
        fs.rmSync(p);
        purge.push(path.relative(stageDir, p));
      }
    }
  };
  walk(stageDir);
  return { copied, purged: purge };
}

/**
 * 重建一个插件产物并回写双清单+台账。
 * @returns {{name,version,artifact,sha256,updated:string[],payload:string[]}}
 */
export function rebuildPlugin(repoRoot, pluginName) {
  const srcDir = path.join(repoRoot, "plugins", pluginName);
  const manifestPath = path.join(srcDir, "plugin.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`源 plugin.json 不存在：plugins/${pluginName}/plugin.json`);
  }
  const identity = readJson(manifestPath);
  if (identity.name !== pluginName) {
    throw new Error(`源身份错位：plugin.json name=${identity.name} ≠ 目录名 ${pluginName}`);
  }
  const version = identity.version;

  // 1) staging：package/ 根目录形态（沙箱安装门布局契约）
  const stageParent = fs.mkdtempSync(path.join(os.tmpdir(), "wfp-rebuild-"));
  const stage = path.join(stageParent, "package");
  fs.mkdirSync(stage);
  const { copied, purged } = copyPayload(srcDir, stage);
  if (!copied.includes("plugin.json")) throw new Error("staging 缺 plugin.json（不可能分支，防御）");

  // 2) 打包：COPYFILE_DISABLE=1 防 macOS 扩展属性脏产物（runbook 同款）
  const outDir = path.join(repoRoot, "plugins", pluginName, "resources");
  fs.mkdirSync(outDir, { recursive: true });
  const artifactRel = `plugins/${pluginName}/resources/${pluginName}-${version}.tgz`;
  const tarOut = spawnSync(
    "tar",
    ["czf", path.join(repoRoot, artifactRel), "package"],
    { cwd: stageParent, env: { ...process.env, COPYFILE_DISABLE: "1" }, encoding: "utf8" }
  );
  fs.rmSync(stageParent, { recursive: true, force: true });
  if (tarOut.status !== 0) throw new Error(`tar 失败：${tarOut.stderr}`);

  // 3) 指纹回写双清单
  const sha256 = sha256File(path.join(repoRoot, artifactRel));
  const updated = [artifactRel];
  const indexPath = path.join(repoRoot, ".claude-plugin", "marketplace.json");
  const index = readJson(indexPath);
  const entry = (index.plugins || []).find((p) => p.name === pluginName);
  if (!entry) throw new Error(`市场清单缺条目：${pluginName}（先登记条目再重建产物）`);
  if (entry["bundled-in-kaleidosphere"]) {
    throw new Error(`${pluginName} 是 bundled 条目，无本地产物可重建`);
  }
  entry.version = version;
  entry.integrity = sha256;
  writeJson(indexPath, index);
  updated.push(".claude-plugin/marketplace.json");

  const agentsPath = path.join(repoRoot, ".agents", "plugins", "marketplace.json");
  if (fs.existsSync(agentsPath)) {
    const agents = readJson(agentsPath);
    const mirror = (agents.plugins || []).find((p) => p.name === pluginName);
    if (mirror) {
      if (mirror.version !== undefined) mirror.version = version;
      writeJson(agentsPath, agents);
      updated.push(".agents/plugins/marketplace.json");
    }
  }

  // 4) provenance 台账自动登记/刷新：溯源字段保留，指纹与日期如实刷
  const provPath = path.join(repoRoot, "provenance.json");
  const provenance = fs.existsSync(provPath) ? readJson(provPath) : { schema: 1, artifacts: [] };
  provenance.artifacts ||= [];
  const prev = provenance.artifacts.find((a) => `${a.plugin}` === pluginName && a.version === version);
  const record = {
    plugin: pluginName,
    version,
    artifact: artifactRel,
    sha256,
    source: prev?.source ?? `./plugins/${pluginName}`,
    sourceRepo: prev?.sourceRepo ?? "cctice/workflow-party（本仓内源目录）",
    builtFrom: `scripts/rebuild-artifacts.mjs 脚本化重建：源 plugin.json 版本 ${version} 同步构建（staging 载荷 ${copied.join("+")}）`,
    recordedAt: prev?.recordedAt ?? today(),
    rebuiltAt: today(),
  };
  const slot = provenance.artifacts.findIndex(
    (a) => a.plugin === pluginName && a.version === version
  );
  if (slot >= 0) provenance.artifacts[slot] = record;
  else provenance.artifacts.push(record);
  // 同插件旧版本记录让位（防死记录：清单已无旧版本条目）
  provenance.artifacts = provenance.artifacts.filter(
    (a) => a.plugin !== pluginName || a.version === version
  );
  writeJson(provPath, provenance);
  updated.push("provenance.json");

  return { name: pluginName, version, artifact: artifactRel, sha256, updated, payload: copied, purged };
}

/** 重建入口：按市场清单本地产物逐个重建，收尾三方对账 */
export function rebuildAll(repoRoot) {
  const index = readJson(path.join(repoRoot, ".claude-plugin", "marketplace.json"));
  const locals = index.plugins.filter((p) => !p["bundled-in-kaleidosphere"]);
  const results = locals.map((p) => rebuildPlugin(repoRoot, p.name));
  const issues = verifyAll(repoRoot);
  return { results, issues };
}

// ---- CLI 直跑 ----
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("用法：node scripts/rebuild-artifacts.mjs --all | <plugin-name>...");
    process.exit(2);
  }
  try {
    const results =
      args.includes("--all")
        ? rebuildAll(root).results
        : args.map((n) => rebuildPlugin(root, n));
    for (const r of results) {
      console.log(`✓ ${r.name}@${r.version} 重建：${r.artifact}（载荷 ${r.payload.join("+")}）`);
      console.log(`  指纹 ${r.sha256}`);
      for (const f of r.updated) console.log(`  回写 ${f}`);
    }
    const issues = verifyAll(root);
    if (issues.length) {
      console.error("✗ 重建后三方对账不绿：");
      for (const i of issues) console.error(`  - ${i}`);
      process.exit(1);
    }
    console.log("✓ 产物信任链对账全绿：tgz 实文件 ↔ 双市场清单 ↔ provenance 台账");
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  }
}
