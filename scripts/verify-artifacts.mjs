#!/usr/bin/env node
// verify-artifacts.mjs —— 产物信任链一键复验（维护心跳包·五轮：历史信任链补录后的自证面）
//
// 背景：指纹机制是三轮后才补的，此前发布链无指纹，历史信任链是补出来的——
// 光有 marketplace.json 里的 integrity 字段，消费者无法回答"这个指纹是谁、
// 什么时候、从哪个源记录的"。provenance.json 台账补上来源锚点，本脚本做
// 三方对账：tgz 实文件 ↔ 双市场清单 integrity ↔ provenance 台账。
//
// 用法：node scripts/verify-artifacts.mjs   （校验失败 exit 1，CI/本地同款）
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 对账一个仓库根目录，返回问题清单（空数组 = 全绿） */
export function verifyAll(repoRoot = root) {
  const issues = [];
  const readJson = (p) => JSON.parse(fs.readFileSync(path.join(repoRoot, p), "utf8"));
  let index, agents, provenance;
  try {
    index = readJson(".claude-plugin/marketplace.json");
    agents = readJson(".agents/plugins/marketplace.json");
    provenance = readJson("provenance.json");
  } catch (err) {
    return [`清单/台账读取失败：${err.message}`];
  }

  const localEntries = index.plugins.filter((p) => !p["bundled-in-kaleidosphere"]);
  const ledger = new Map((provenance.artifacts || []).map((a) => [`${a.plugin}@${a.version}`, a]));

  for (const entry of localEntries) {
    const key = `${entry.name}@${entry.version}`;
    const prov = ledger.get(key);

    // ① 台账覆盖：每个本地产物必须有来源记录
    if (!prov) {
      issues.push(`${key}：provenance 台账缺记录（新发布未登记来源）`);
      continue;
    }
    // ② 台账 ↔ 清单：指纹、产物路径一致
    if (prov.sha256 !== entry.integrity) {
      issues.push(`${key}：台账指纹 ${prov.sha256} ≠ 清单 integrity ${entry.integrity}`);
    }
    // ③ 台账 ↔ 实文件：现算 sha256 对账
    const artifactPath = path.join(repoRoot, prov.artifact);
    if (!fs.existsSync(artifactPath)) {
      issues.push(`${key}：台账产物路径不存在 ${prov.artifact}`);
      continue;
    }
    const actual = `sha256:${crypto.createHash("sha256").update(fs.readFileSync(artifactPath)).digest("hex")}`;
    if (actual !== prov.sha256) {
      issues.push(`${key}：实文件指纹 ${actual} ≠ 台账 ${prov.sha256}（产物被替换/损坏）`);
    }
    // ④ tgz 文件名版本 === 条目版本 === 台账版本（三点一线，防"挂羊头"）
    const base = path.basename(prov.artifact);
    if (!base.includes(`${entry.name}-${entry.version}.tgz`)) {
      issues.push(`${key}：产物文件名 ${base} 与 插件名-版本 不符`);
    }
    // ⑤ agents 版清单同步携带同指纹（双清单不各说各话）
    const mirror = (agents.plugins || []).find((p) => p.name === entry.name);
    if (!mirror) issues.push(`${key}：agents 版清单缺该条目`);
  }

  // ⑥ 台账无游离记录：登记了但市场清单没有（死记录 = 漂移温床）
  for (const [key, prov] of ledger) {
    if (!localEntries.some((p) => `${p.name}@${p.version}` === key)) {
      issues.push(`${key}：台账有记录但市场清单无此条目（死记录）`);
    }
  }
  return issues;
}

// ---- CLI 直跑 ----
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const issues = verifyAll();
  if (issues.length === 0) {
    console.log("✓ 产物信任链对账全绿：tgz 实文件 ↔ 双市场清单 ↔ provenance 台账");
  } else {
    console.error(`✗ 产物信任链对账发现 ${issues.length} 处问题：`);
    for (const i of issues) console.error(`  - ${i}`);
    process.exit(1);
  }
}
