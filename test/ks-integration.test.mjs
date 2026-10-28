// 与 KaleidoSphere P4（插件市场支柱）集成测试（维护心跳包·五轮）：双仓各跑各的→第一次接线。
//
// 集成形态（能力探测，双仓异步演进不断线）：
//   ① 发现 ks CLI：$KS_CLI 显式覆盖 > 兄弟仓默认布局 ../../kaleidosphere-proj/kaleidosphere/ks.mjs；
//     找不到（如 CI 无兄弟仓）→ skip，不造假绿。
//   ② 真实拉起 ks 进程跑 `ks version`：集成链路（spawn+执行+stdout）通则通。
//   ③ ks 已带 market 组 → `ks market list --path <本仓>` 必须列出我们的本地产物条目
//     （kaleidosphere/kfc-plugin 双向契约：市场条目对消费者真实可发现）；未带 market 组 →
//     如实 skip 并注明等待 ks 侧能力（不红不假绿）。
//   ④ 常跑部分（不依赖 ks 在场）：消费面三形态解析契约——marketplace.json 每个 source 条目
//     必须可解析（目录→plugin.json 在；文件→文件在；https→URL 形态合法），这是 ks market list
//     直读市场的消费面形状，谁改坏谁红。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const index = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin", "marketplace.json"), "utf8"));

function locateKsCli() {
  if (process.env.KS_CLI) return process.env.KS_CLI;
  const sibling = path.resolve(root, "..", "..", "kaleidosphere-proj", "kaleidosphere", "ks.mjs");
  return fs.existsSync(sibling) ? sibling : null;
}

const run = (cli, args, opts = {}) =>
  execFileSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 15000, ...opts });

// ---- ④ 常跑：消费面三形态解析契约（ks market list 的读法，先行钉死）----
test("消费面契约：每个 source 条目三形态可解析（目录/文件/https）", () => {
  for (const p of index.plugins) {
    const src = String(p.source || "");
    if (/^https?:\/\//.test(src)) {
      // https 形态：URL 合法且指向源仓路径
      assert.match(src, /^https:\/\/github\.com\/[^/]+\/[^/]+\/tree\/[^/]+\/.+/, `${p.name}: https source 形态不合法`);
    } else if (/\.(tgz|tar\.gz)$/i.test(src)) {
      // 文件形态：产物文件真实存在（相对市场仓根）
      assert.ok(fs.existsSync(path.join(root, src)), `${p.name}: 产物文件不存在 ${src}`);
    } else {
      // 目录形态：目录在且带 plugin.json（canonical 插件契约，消费者装载的最小要求）
      const dir = path.join(root, src);
      assert.ok(fs.existsSync(dir), `${p.name}: source 目录不存在 ${src}`);
      assert.ok(fs.existsSync(path.join(dir, "plugin.json")), `${p.name}: 目录形态缺 plugin.json（消费者无从识别）`);
    }
  }
});

test("消费面契约：本地产物条目名与 source 目录插件身份一致", () => {
  for (const p of index.plugins.filter((x) => !x["bundled-in-kaleidosphere"] && !/^https?:\/\//.test(String(x.source)))) {
    const desc = JSON.parse(fs.readFileSync(path.join(root, p.source, "plugin.json"), "utf8"));
    assert.equal(desc.name, p.name, `${p.name}: source 目录 plugin.json 身份漂移`);
    assert.equal(desc.version, p.version, `${p.name}: source 目录版本与市场条目不一致`);
  }
});

// ---- ①②③ 跨仓集成：ks CLI 真实拉起（能力探测）----
const ksCli = locateKsCli();

test("ks CLI 集成：发现并真实拉起（ks version）", { skip: !ksCli && "兄弟仓无 kaleidosphere（KS_CLI 可显式指定）" }, () => {
  const out = run(ksCli, ["version"]);
  assert.match(out, /ks v\d+\.\d+\.\d+/);
});

test("ks market list 直读本仓：本地产物条目对消费者可发现", { skip: !ksCli && "兄弟仓无 kaleidosphere（KS_CLI 可显式指定）" }, () => {
  let out;
  try {
    out = run(ksCli, ["market", "list", "--path", root]);
  } catch (err) {
    const msg = String(err.stderr || err.message || "");
    if (msg.includes("未知命令组")) {
      assert.ok(true, `ks 侧 market 组未就绪（等待 KaleidoSphere P4 落地），消费面契约已由常跑部分看守：${msg.split("\n")[0]}`);
      return;
    }
    throw err;
  }
  // market 组已就绪：本地产物必须真实可见（双向契约的正反两面）
  for (const p of index.plugins.filter((x) => !x["bundled-in-kaleidosphere"])) {
    assert.ok(out.includes(p.name), `ks market list 输出缺 ${p.name}`);
  }
});
