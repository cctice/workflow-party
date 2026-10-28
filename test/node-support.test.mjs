// 多 Node 版本支持门（维护心跳包·五轮）：此前 CI 仅 Node 22 单环境，20/24 从未验证——
// "只在我机器的 Node 上绿"是单点真相。本门看守三点一线 + 版本敏感 API 不越线：
//   ① .nvmrc（本地开发基准）落在 engines.node 范围内
//   ② .github/workflows/ci.yml 的全部 node-version 都落在 engines 范围内（矩阵不许越界）
//   ③ 版本敏感内置模块扫描：engines 下限承诺到哪，代码就只能用到哪
//     （node:sqlite 需 22+；若用了它而 engines 还是 >=20，本门红——先提下限再用新 API）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

/** 解析 ">=major[.minor]" 形态 engines 下限 → [major, minor]（不支持别的形态：写别的形态直接红，逼明确） */
function enginesFloor(range) {
  const m = String(range || "").match(/^>=\s*(\d+)(?:\.(\d+))?$/);
  if (!m) throw new Error(`engines.node 形态不受本门支持（只认 >=major[.minor]）：${range}`);
  return [Number(m[1]), Number(m[2] || 0)];
}

/** 版本是否满足下限："22" / "20.11" → 比较 major/minor */
function satisfiesFloor(version, floor) {
  const parts = String(version).split(".").map((n) => Number(n) || 0);
  const vmaj = parts[0];
  const vmin = parts[1] ?? 0; // "20" 视为 20.0（setup-node 裸 major 解析到最新 minor，天然 ≥20.0）
  const [fmaj, fmin] = floor;
  return vmaj > fmaj || (vmaj === fmaj && vmin >= fmin);
}

test("engines.node 存在且下限形态可解析", () => {
  assert.ok(pkg.engines?.node, "package.json 缺 engines.node");
  assert.doesNotThrow(() => enginesFloor(pkg.engines.node));
});

test(".nvmrc 本地基准落在 engines 范围内", () => {
  const nvmrc = fs.readFileSync(path.join(root, ".nvmrc"), "utf8").trim();
  assert.match(nvmrc, /^\d+(\.\d+)?$/, ".nvmrc 应为纯版本号");
  assert.ok(satisfiesFloor(nvmrc, enginesFloor(pkg.engines.node)), `.nvmrc ${nvmrc} 越出 engines ${pkg.engines.node}`);
});

test("ci.yml 全部 node-version 落在 engines 范围内（矩阵不许越界）", () => {
  let ci;
  try {
    ci = fs.readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  } catch {
    // 远端无 workflow scope：ci.yml 是本地保留件（7dc501c 先例），缺席时降级为
    // nvmrc/engines 双点一致性（本测试其余用例已覆盖），矩阵断言只在文件在场时执行。
    assert.ok(fs.existsSync(path.join(root, ".nvmrc")), "ci.yml 缺席时 .nvmrc 必须仍在（基准不能丢）");
    return;
  }
  const versions = [...ci.matchAll(/node-version:\s*(?:\$\{\{\s*matrix\.node\s*\}\}|\[([^\]]+)\]|["']?([\d.]+))/g)]
    .flatMap((m) => (m[2] ? [m[2]] : m[1] ? m[1].split(",").map((s) => s.replace(/["'\s]/g, "")) : []));
  // 矩阵定义行：node: [20, 22, 24]
  const matrix = ci.match(/matrix:\s*\n\s*node:\s*\[([^\]]+)\]/)?.[1]
    ?.split(",").map((s) => s.replace(/["'\s]/g, "")).filter(Boolean) || [];
  const all = [...new Set([...versions, ...matrix])];
  assert.ok(all.length >= 2, `多版本矩阵未配置（只发现 ${all.join(",") || "无"}）——单环境单真相`);
  for (const v of all) {
    assert.ok(satisfiesFloor(v, enginesFloor(pkg.engines.node)), `ci.yml node ${v} 越出 engines ${pkg.engines.node}`);
  }
});

test("版本敏感 API 不越线：node:sqlite（22+）若在用，engines 下限必须 ≥22", () => {
  const floor = enginesFloor(pkg.engines.node);
  // 只扫运行时代码（scripts/）：测试文件若用 22+ API，Node 20 矩阵当场跑挂，无需本门重复看守
  const SQLITE_NEEDLE = ["node", "sqlite"].join(":");
  const runtimeSources = fs.readdirSync(path.join(root, "scripts")).filter((f) => f.endsWith(".mjs"))
    .map((f) => path.join(root, "scripts", f));
  const usesSqlite = runtimeSources.some((f) => fs.readFileSync(f, "utf8").includes(SQLITE_NEEDLE));
  if (usesSqlite) {
    assert.ok(floor[0] >= 22, "代码用了 node:sqlite（需 22+）但 engines 下限还承诺到更低——先提下限");
  } else {
    assert.ok(floor[0] <= 22, "未用 22+ API 时下限不必收紧到 22 以上（保持 20.x 兼容承诺）");
  }
});
